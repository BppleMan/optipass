import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";
import cors from "@fastify/cors";
import Fastify, { FastifyInstance, FastifyRequest } from "fastify";
import {
  ActionDraft,
  ActionDraftGroup,
  ActionDraftItem,
  ActionPlan,
  ActionPlanGroup,
  createActionPlan,
  createExecutionPlan,
  findDuplicateGroups,
  GroupDecision,
  ItemSummary,
  normalizeLooseText,
  normalizeUrlHost,
  PlanAction,
  RevealedCredentialField,
  RevealCredentialsResponse,
  ScanProgress,
  ScanProgressEvent,
  ScanSnapshot,
  ScanResult,
  summarizeVaults,
  validateDecisionItemSet
} from "@optimize-password/core";
import { z, ZodError } from "zod";
import { ApiConfig, AppMode } from "./config.js";
import { createMockScanResult } from "./mock-data.js";

export interface PasswordService {
  scan(options: {
    scanId?: string;
    serviceAccountToken?: string;
    accountName?: string;
    onProgress?: (event: ScanProgressEvent) => void;
  }): Promise<ScanSnapshot>;
  revealCredentials(appItemId: string): Promise<RevealedCredentialField[]>;
  archive(vaultId: string, onePasswordItemId: string): Promise<void>;
  delete(vaultId: string, onePasswordItemId: string): Promise<void>;
  removeTags(appItemId: string, removeTags: string[]): Promise<void>;
  copyToVaultAndArchiveSource(appItemId: string, targetVaultId: string, removeTags?: string[]): Promise<CopyToVaultResult>;
  listItemStates(vaultId: string): Promise<ItemStateSnapshot>;
  clearCache(): void;
}

export interface CreateApiServerOptions {
  config: ApiConfig;
  onePassword: PasswordService;
  logger?: boolean | { level: string };
  lifecycle?: ApiLifecycleOptions;
}

export interface ApiLifecycleOptions {
  shutdown?: {
    enabled: boolean;
    onShutdown?: (reason: "requested" | "idle") => void | Promise<void>;
  };
}

type ScanMode = "live" | "mock";
const permanentDeleteConfirmationPhrase = "永久删除";
const revealExpiresInSeconds = 30;
type DecisionBody = GroupDecision & {
  confirmPermanentDelete?: boolean;
  permanentDeleteConfirmationPhrase?: string;
  confirmedDryRunKey?: string;
  dryRun?: boolean;
};

interface ScanStartResponse {
  scanId: string;
  mode: ScanMode;
  progress: ScanProgress;
  eventsToken: string;
}

interface ActiveScanResponse extends ScanStartResponse {
  eventCount: number;
}

export interface ItemStateSnapshot {
  activeIds: string[];
  archivedIds: string[];
}

export interface CopyToVaultResult {
  createdItemId: string;
}

interface ExecuteActionResult {
  itemId: string;
  action: PlanAction["type"];
  ok: boolean;
  error?: string;
  skipped?: boolean;
  createdItemId?: string;
  targetVaultId?: string;
  dryRun?: boolean;
}

interface VerificationResult {
  itemId?: string;
  vaultId: string;
  action?: PlanAction["type"];
  ok: boolean;
  severity: "critical" | "incomplete";
  message: string;
}

interface ExecutionVerification {
  ok: boolean;
  results: VerificationResult[];
}

interface ScanJob {
  scanId: string;
  mode: ScanMode;
  eventsToken: string;
  progress: ScanProgress;
  events: ScanProgressEvent[];
  subscribers: Set<(event: ScanProgressEvent) => void>;
  done: boolean;
  cancelled: boolean;
}

interface ExecutionStartResponse {
  executionId: string;
  eventsToken: string;
  dryRun: boolean;
  totalOperations: number;
}

interface ExecutionProgressEvent {
  type: "started" | "action-started" | "action" | "completed" | "failed";
  sequence: number;
  executionId: string;
  dryRun: boolean;
  totalOperations: number;
  completedOperations: number;
  action?: {
    itemId: string;
    type: string;
  };
  result?: ExecuteActionResult;
  response?: Record<string, unknown>;
  error?: string;
}

interface ExecutionJob {
  executionId: string;
  eventsToken: string;
  events: ExecutionProgressEvent[];
  subscribers: Set<(event: ExecutionProgressEvent) => void>;
  done: boolean;
}

type ActionExecutionStatus =
  | "running"
  | "pause-requested"
  | "paused"
  | "stop-requested"
  | "refreshing-after-stop"
  | "refreshing"
  | "stopped"
  | "completed"
  | "failed";

interface ActionPlanQueueEntry {
  entryId: string;
  groupId: string;
  groupIndex: number;
  actionIndex: number;
  action: PlanAction;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result?: ExecuteActionResult;
}

interface ActionEffect {
  groupId: string;
  sourceItemId: string;
  createdItemId?: string;
  createdOnePasswordItemId?: string;
  actionType: PlanAction["type"];
  wroteToOnePassword: boolean;
  succeeded: boolean;
}

interface ActionExecutionEvent {
  type: string;
  sequence: number;
  executionId: string;
  status: ActionExecutionStatus;
  writeEnabled: boolean;
  totalGroups: number;
  totalOperations: number;
  completedOperations: number;
  groupId?: string;
  entryId?: string;
  action?: { itemId: string; type: PlanAction["type"] };
  result?: ExecuteActionResult;
  progress?: ScanProgress;
  response?: Record<string, unknown>;
  error?: string;
}

interface ActionExecutionJob {
  executionId: string;
  tabId: string;
  eventsToken: string;
  draft: ActionDraft;
  plan: ActionPlan;
  queue: ActionPlanQueueEntry[];
  cursor: number;
  status: ActionExecutionStatus;
  pauseRequested: boolean;
  stopRequested: boolean;
  runningAction: boolean;
  results: ExecuteActionResult[];
  effects: ActionEffect[];
  events: ActionExecutionEvent[];
  subscribers: Set<(event: ActionExecutionEvent) => void>;
  resumeWaiters: Set<() => void>;
  done: boolean;
}

interface TabAnalysisState {
  analysis?: ScanResult;
  dryRunKey?: string;
  skippedGroups: string[];
}

interface AnalysisResultResponse extends ScanResult {
  skippedGroupIds: string[];
}

interface ItemSearchResponse {
  itemIds: string[];
  suggestions: ItemSearchSuggestion[];
}

type ItemSearchSuggestionKind = "year" | "vault" | "credential" | "domain" | "field";
type ItemSearchField = "title" | "username" | "url" | "phone" | "email" | "note";

interface ItemSearchSuggestion {
  id: string;
  kind: ItemSearchSuggestionKind;
  label: string;
  field?: ItemSearchField;
  itemIds: string[];
  count: number;
}

export async function createApiServer(options: CreateApiServerOptions): Promise<FastifyInstance> {
  const { config, onePassword } = options;
  const mode = sessionMode(config);
  const canShutdown = Boolean(options.lifecycle?.shutdown?.enabled);
  let enableMutations = config.enableMutations;
  let latestScan: ScanSnapshot | undefined;
  let latestScanMode: ScanMode | undefined;
  let latestScanAccountName: string | undefined;
  let activeMutationScanId: string | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const scanJobs = new Map<string, ScanJob>();
  const executionJobs = new Map<string, ExecutionJob>();
  const actionExecutionJobs = new Map<string, ActionExecutionJob>();
  const tabStates = new Map<string, TabAnalysisState>();

  function tabStateFor(request: FastifyRequest): TabAnalysisState {
    const tabId = tabIdFor(request);
    let state = tabStates.get(tabId);
    if (!state) {
      state = { skippedGroups: [] };
      tabStates.set(tabId, state);
    }
    return state;
  }

  function optionalTabAnalysisState(request: FastifyRequest): TabAnalysisState | undefined {
    return tabStates.get(tabIdFor(request));
  }

  const server = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL || "info"
    }
  });

  await server.register(cors, {
    origin: config.webOrigins,
    credentials: false,
    methods: ["GET", "HEAD", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["content-type", "x-session-token", "x-tab-id"]
  });

  server.addHook("onRequest", async () => {
    refreshIdleTimer();
  });

  server.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    reply.header("content-security-policy", securityPolicy());
    return payload;
  });

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ClientInputError || error instanceof ZodError) {
      return reply.code(400).send({
        statusCode: 400,
        error: "请求错误",
        message: error instanceof ZodError ? "请求参数格式不正确，请刷新页面后重试。" : error.message
      });
    }

    return reply.send(error);
  });

  server.addHook("preHandler", async (request, reply) => {
    if (request.url === "/healthz") {
      return;
    }
    if (request.url === "/api/session" && mode !== "tauri") {
      return;
    }
    if (!request.url.startsWith("/api/")) {
      return;
    }

    const token = request.headers["x-session-token"];
    if (token === config.sessionToken || isAuthorizedEventStream(request.url, scanJobs, executionJobs, actionExecutionJobs)) {
      return;
    }

    await reply.code(401).send({ error: "本地会话令牌无效，请刷新页面后重试。" });
  });

  function sessionResponse() {
    return {
      token: config.sessionToken,
      mode,
      accountName: config.accountName,
      resumeAccountName: latestScanAccountName,
      apiBaseUrl: `http://${config.host}:${config.port}`,
      enableMutations,
      hasServiceAccountToken: Boolean(config.serviceAccountToken),
      supportsDesktopAuth: true,
      idleShutdownMs: config.idleShutdownMs ?? null,
      capabilities: sessionCapabilities(mode, canShutdown, Boolean(config.webDistDir), config.idleShutdownMs)
    };
  }

  server.get("/healthz", async () => ({ ok: true }));

  server.get("/api/session", async () => sessionResponse());

  server.patch("/api/session/mutations", async (request) => {
    const body = z.object({ enableMutations: z.boolean() }).parse(request.body);
    enableMutations = body.enableMutations;
    return sessionResponse();
  });

  server.post("/api/session/heartbeat", async () => ({
    ok: true,
    idleShutdownMs: config.idleShutdownMs ?? null
  }));

  server.post("/api/session/shutdown", async (_request, reply) => {
    if (!canShutdown) {
      return reply.code(404).send({ error: "当前启动模式不支持由页面关闭本地服务。" });
    }
    if (hasActiveWork()) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前仍有扫描或执行任务运行中，暂不关闭本地服务。"
      });
    }

    scheduleShutdown("requested");
    return { ok: true };
  });

  server.get("/api/scan", async () => {
    if (!latestScan) {
      throw new ClientInputError("还没有扫描结果，请先运行一次扫描。");
    }
    return redactScanSnapshotForClient(latestScan);
  });

  server.post("/api/items/search", async (request): Promise<ItemSearchResponse> => {
    const body = itemSearchBodySchema.parse(request.body);
    if (!latestScan) {
      throw new ClientInputError("还没有扫描结果，请先运行一次扫描。");
    }
    return buildItemSearchResponse(latestScan.items, body.keywords);
  });

  server.get("/api/analysis", async (request) => {
    const state = optionalTabAnalysisState(request);
    if (!state?.analysis) {
      throw new ClientInputError("还没有分析结果，请先完成扫描并手动运行分析。");
    }
    return analysisResultResponse(state, currentAnalysisForGlobalScan(state.analysis, latestScan));
  });

  server.post("/api/scan/clear", async (request, reply) => {
    if (activeMutationScanId) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前已有执行任务正在运行，请等待完成后再清空扫描结果。"
      });
    }

    latestScan = undefined;
    latestScanMode = undefined;
    latestScanAccountName = undefined;
    tabStates.delete(tabIdFor(request));
    cancelScanJobs(scanJobs);
    scanJobs.clear();
    onePassword.clearCache();

    return { ok: true };
  });

  server.post("/api/scan", async (request, reply): Promise<ScanStartResponse | unknown> => {
    if (activeMutationScanId || hasActiveScanJob()) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前已有执行任务正在运行，请等待完成后再重新扫描。"
      });
    }

    const body = scanBodySchema.parse(request.body ?? {});
    const scanId = createScanId();
    resetTabAnalysisState(tabStateFor(request));

    const job = createScanJob(scanId, body.mode);
    scanJobs.set(scanId, job);

    if (body.mode === "mock") {
      void runMockScanJob(job);
      return { scanId, mode: body.mode, progress: job.progress, eventsToken: job.eventsToken };
    }

    const accountName = body.accountName || config.accountName;
    if (!config.serviceAccountToken && !accountName) {
      scanJobs.delete(scanId);
      throw new ClientInputError("官方 1Password SDK 的 Desktop App 授权需要账户名或 account_uuid 来定位账户。它不是密码或 token；请在页面顶部填写，或用 OP_ACCOUNT_NAME 设置默认值。");
    }

    void runLiveScanJob(job, accountName);
    return { scanId, mode: body.mode, progress: job.progress, eventsToken: job.eventsToken };
  });

  server.get("/api/scan/active", async (): Promise<ActiveScanResponse> => {
    const activeJob = Array.from(scanJobs.values()).find((job) => !job.done);
    if (!activeJob) {
      throw new ClientInputError("当前没有正在运行的扫描任务。");
    }

    return {
      scanId: activeJob.scanId,
      mode: activeJob.mode,
      progress: activeJob.progress,
      eventsToken: activeJob.eventsToken,
      eventCount: activeJob.events.length
    };
  });

  server.get("/api/scan/events", async (request, reply) => {
    const query = scanEventsQuerySchema.parse(request.query ?? {});
    const job = scanJobs.get(query.scanId);
    if (!job) {
      throw new ClientInputError("找不到扫描任务，请重新开始扫描。");
    }
    if (job.eventsToken !== query.eventsToken) {
      throw new ClientInputError("扫描事件令牌无效，请重新开始扫描。");
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "connection": "keep-alive",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": securityPolicy(),
      ...corsHeadersFor(request.headers.origin, config.webOrigins)
    });

    for (const event of job.events.slice(query.after)) {
      reply.raw.write(toSseMessage(event));
    }

    if (job.done) {
      reply.raw.end();
      return;
    }

    const keepAlive = setInterval(() => {
      if (!reply.raw.destroyed) {
        reply.raw.write(": keep-alive\n\n");
      }
    }, 15_000);
    keepAlive.unref();

    const cleanup = (): void => {
      clearInterval(keepAlive);
      job.subscribers.delete(subscriber);
    };

    const subscriber = (event: ScanProgressEvent): void => {
      if (reply.raw.destroyed) {
        cleanup();
        return;
      }
      reply.raw.write(toSseMessage(event));
      if (event.type === "completed" || event.type === "failed") {
        reply.raw.end();
        cleanup();
      }
    };

    job.subscribers.add(subscriber);
    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
  });

  server.post("/api/analyze", async (request) => {
    const body = analyzeBodySchema.parse(request.body ?? {});
    const scan = currentScanSnapshotFor(body.scanId, latestScan);
    const state = tabStateFor(request);
    state.analysis = analyzeScan(scan);
    state.dryRunKey = undefined;
    state.skippedGroups = [];
    return analysisResultResponse(state, state.analysis);
  });

  server.post("/api/items/:itemId/reveal", async (request): Promise<RevealCredentialsResponse> => {
    const params = itemParamsSchema.parse(request.params);
    const body = revealBodySchema.parse(request.body ?? {});
    const scan = currentScanSnapshotFor(body.scanId, latestScan);
    if (!scan.items.some((item) => item.id === params.itemId)) {
      throw new ClientInputError(`找不到项目：${params.itemId}`);
    }

    const fields = latestScanMode === "mock"
      ? mockRevealCredentials(params.itemId)
      : await onePassword.revealCredentials(params.itemId);

    return {
      scanId: scan.scanId,
      itemId: params.itemId,
      fields,
      expiresInSeconds: revealExpiresInSeconds
    };
  });

  server.post("/api/plan", async (request) => {
    const decision = decisionSchema.parse(request.body) satisfies DecisionBody;
    const state = tabStateFor(request);
    currentAnalysisForGlobalScan(currentAnalysisFor(decision.scanId, state.analysis), latestScan);
    assertGroupIsNotSkipped(state, decision.groupId);
    const plan = createPlanFromLatestScan(decision, state.analysis);
    return plan;
  });

  server.post("/api/groups/:groupId/skip", async (request, reply) => {
    if (activeMutationScanId) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前已有执行任务正在运行，请等待完成后再跳过重复组。"
      });
    }

    const params = groupParamsSchema.parse(request.params);
    const body = skipGroupBodySchema.parse(request.body ?? {});
    const state = tabStateFor(request);
    const scan = currentAnalysisForGlobalScan(currentAnalysisFor(body.scanId, state.analysis), latestScan);
    const skippedGroup = scan.groups.find((group) => group.id === params.groupId);
    if (!skippedGroup) {
      throw new ClientInputError(`找不到重复组：${params.groupId}`);
    }

    if (!state.skippedGroups.includes(params.groupId)) {
      state.skippedGroups.push(params.groupId);
    }
    state.dryRunKey = undefined;

    return {
      skippedGroupId: params.groupId,
      restorableSkippedGroupCount: state.skippedGroups.length,
      scan: analysisResultResponse(state, scan)
    };
  });

  server.post("/api/groups/:groupId/restore", async (request, reply) => {
    if (activeMutationScanId) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前已有执行任务正在运行，请等待完成后再取消跳过标记。"
      });
    }

    const params = groupParamsSchema.parse(request.params);
    const body = skipGroupBodySchema.parse(request.body ?? {});
    const state = tabStateFor(request);
    const scan = currentAnalysisForGlobalScan(currentAnalysisFor(body.scanId, state.analysis), latestScan);
    if (!state.skippedGroups.includes(params.groupId)) {
      throw new ClientInputError(`该重复组未被标记跳过：${params.groupId}`);
    }

    state.skippedGroups = state.skippedGroups.filter((groupId) => groupId !== params.groupId);
    state.dryRunKey = undefined;
    return {
      skippedGroupId: params.groupId,
      restorableSkippedGroupCount: state.skippedGroups.length,
      scan: analysisResultResponse(state, scan)
    };
  });

  server.post("/api/groups/restore-skipped", async (request, reply) => {
    if (activeMutationScanId) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前已有执行任务正在运行，请等待完成后再恢复跳过的重复组。"
      });
    }

    const body = restoreSkippedBodySchema.parse(request.body ?? {});
    const state = tabStateFor(request);
    const scan = currentAnalysisForGlobalScan(currentAnalysisFor(body.scanId, state.analysis), latestScan);
    const restoredGroupId = state.skippedGroups.pop();
    if (!restoredGroupId) {
      throw new ClientInputError("没有可恢复的已跳过重复组。");
    }
    state.dryRunKey = undefined;

    return {
      restoredGroupId,
      restorableSkippedGroupCount: state.skippedGroups.length,
      scan: analysisResultResponse(state, scan)
    };
  });

  server.post("/api/action-executions/start", async (request, reply) => {
    const body = actionExecutionStartSchema.parse(request.body);
    const state = tabStateFor(request);
    const analysis = currentAnalysisForGlobalScan(currentAnalysisFor(body.draft.scanId, state.analysis), latestScan);
    if (activeMutationScanId || hasActiveScanJob() || activeActionExecution()) {
      return reply.code(409).send({ error: "冲突", message: "当前已有扫描或执行任务正在运行。" });
    }

    const writeEnabled = latestScanMode !== "mock" && enableMutations;
    const plan = createActionPlan(body.draft, analysis, writeEnabled);
    const targetVaultBlockers = body.draft.groups.flatMap((group) => validateTargetVaults(group, analysis));
    plan.blockers = Array.from(new Set([...plan.blockers, ...targetVaultBlockers]));
    if (plan.blockers.length > 0) {
      return reply.code(422).send({ error: "计划不可执行", message: plan.blockers.join("\n"), plan });
    }
    if (plan.requiresExplicitDeleteConfirmation && body.permanentDeleteConfirmationPhrase !== permanentDeleteConfirmationPhrase) {
      return reply.code(422).send({ error: "需要确认", message: `永久删除需要输入“${permanentDeleteConfirmationPhrase}”确认。` });
    }

    const job = createActionExecutionJob(randomUUID(), tabIdFor(request), body.draft, plan);
    actionExecutionJobs.set(job.executionId, job);
    activeMutationScanId = body.draft.scanId;
    void runActionExecution(job, state);
    return actionExecutionSnapshot(job, true);
  });

  server.get("/api/action-executions/:executionId", async (request) => {
    const params = actionExecutionParamsSchema.parse(request.params);
    return actionExecutionSnapshot(actionExecutionFor(params.executionId), true);
  });

  server.post("/api/action-executions/:executionId/pause", async (request, reply) => {
    const params = actionExecutionParamsSchema.parse(request.params);
    const job = actionExecutionFor(params.executionId);
    if (terminalActionExecution(job.status)) {
      return reply.code(409).send({ error: "任务已结束", message: "已结束的执行任务不能暂停。" });
    }
    if (job.status !== "paused" && !job.pauseRequested) {
      job.pauseRequested = true;
      job.status = "pause-requested";
      if (!job.runningAction) {
        enterPaused(job);
      }
    }
    return actionExecutionSnapshot(job);
  });

  server.post("/api/action-executions/:executionId/resume", async (request, reply) => {
    const params = actionExecutionParamsSchema.parse(request.params);
    const job = actionExecutionFor(params.executionId);
    if (job.status !== "paused") {
      return reply.code(409).send({ error: "无法继续", message: "只有已暂停的执行任务可以继续。" });
    }
    job.pauseRequested = false;
    job.status = "running";
    emitActionExecutionEvent(job, { type: "resumed" });
    for (const resume of job.resumeWaiters) {
      resume();
    }
    job.resumeWaiters.clear();
    return actionExecutionSnapshot(job);
  });

  server.post("/api/action-executions/:executionId/stop", async (request) => {
    const params = actionExecutionParamsSchema.parse(request.params);
    const job = actionExecutionFor(params.executionId);
    if (!terminalActionExecution(job.status) && !job.stopRequested) {
      job.stopRequested = true;
      job.pauseRequested = false;
      job.status = "stop-requested";
      emitActionExecutionEvent(job, { type: "stop-requested" });
      for (const resume of job.resumeWaiters) {
        resume();
      }
      job.resumeWaiters.clear();
    }
    return actionExecutionSnapshot(job);
  });

  server.get("/api/action-executions/:executionId/events", async (request, reply) => {
    const params = actionExecutionParamsSchema.parse(request.params);
    const query = actionExecutionEventsQuerySchema.parse(request.query ?? {});
    const job = actionExecutionFor(params.executionId);
    if (job.eventsToken !== query.eventsToken) {
      throw new ClientInputError("执行事件令牌无效，请重新开始应用计划。");
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "connection": "keep-alive",
      ...corsHeadersFor(request.headers.origin, config.webOrigins)
    });
    const offset = Math.max(query.after, lastEventSequence(request.headers["last-event-id"]));
    for (const event of job.events.filter((event) => event.sequence > offset)) {
      reply.raw.write(toSseMessage(event));
    }
    if (job.done) {
      reply.raw.end();
      return;
    }
    const keepAlive = setInterval(() => !reply.raw.destroyed && reply.raw.write(": keep-alive\n\n"), 15_000);
    keepAlive.unref();
    const cleanup = (): void => {
      clearInterval(keepAlive);
      job.subscribers.delete(subscriber);
    };
    const subscriber = (event: ActionExecutionEvent): void => {
      if (reply.raw.destroyed) {
        cleanup();
        return;
      }
      reply.raw.write(toSseMessage(event));
      if (event.type === "stopped" || event.type === "completed" || event.type === "failed") {
        reply.raw.end();
        cleanup();
      }
    };
    job.subscribers.add(subscriber);
    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
  });

  server.post("/api/execute/start", async (request, reply): Promise<ExecutionStartResponse | unknown> => {
    const decision = decisionSchema.parse(request.body) satisfies DecisionBody;
    const state = tabStateFor(request);
    currentAnalysisForGlobalScan(currentAnalysisFor(decision.scanId, state.analysis), latestScan);
    assertGroupIsNotSkipped(state, decision.groupId);
    const plan = createPlanFromLatestScan(decision, state.analysis);

    if (activeMutationScanId) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前已有执行任务正在运行，请等待完成后再继续。"
      });
    }
    if (hasActiveScanJob()) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前仍有扫描任务运行中，请等待扫描完成并重新分析后再执行。"
      });
    }

    const executionId = randomUUID();
    const dryRun = latestScanMode === "mock" || !enableMutations;
    const job = createExecutionJob(executionId);
    executionJobs.set(executionId, job);
    activeMutationScanId = decision.scanId;
    void runExecutionJob(job, state, decision, plan, dryRun);

    return {
      executionId,
      eventsToken: job.eventsToken,
      dryRun,
      totalOperations: plan.actions.filter((action) => action.type !== "keep").length
    };
  });

  server.get("/api/execute/events", async (request, reply) => {
    const query = executionEventsQuerySchema.parse(request.query ?? {});
    const job = executionJobs.get(query.executionId);
    if (!job || job.eventsToken !== query.eventsToken) {
      throw new ClientInputError("执行事件令牌无效，请重新开始应用计划。");
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "connection": "keep-alive",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": securityPolicy(),
      ...corsHeadersFor(request.headers.origin, config.webOrigins)
    });

    const eventOffset = Math.max(query.after, lastEventSequence(request.headers["last-event-id"]));
    for (const event of job.events.slice(eventOffset)) {
      reply.raw.write(toSseMessage(event));
    }

    if (job.done) {
      reply.raw.end();
      return;
    }

    const keepAlive = setInterval(() => {
      if (!reply.raw.destroyed) {
        reply.raw.write(": keep-alive\n\n");
      }
    }, 15_000);
    keepAlive.unref();

    const cleanup = (): void => {
      clearInterval(keepAlive);
      job.subscribers.delete(subscriber);
    };
    const subscriber = (event: ExecutionProgressEvent): void => {
      if (reply.raw.destroyed) {
        cleanup();
        return;
      }
      reply.raw.write(toSseMessage(event));
      if (event.type === "completed" || event.type === "failed") {
        reply.raw.end();
        cleanup();
      }
    };

    job.subscribers.add(subscriber);
    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
  });

  server.post("/api/execute", async (request) => {
    const decision = decisionSchema.parse(request.body) satisfies DecisionBody;
    const state = tabStateFor(request);
    currentAnalysisForGlobalScan(currentAnalysisFor(decision.scanId, state.analysis), latestScan);
    assertGroupIsNotSkipped(state, decision.groupId);
    const plan = createPlanFromLatestScan(decision, state.analysis);

    if (plan.blockers.length > 0) {
      return { plan, results: [], blocked: true };
    }
    if (decision.dryRun || latestScanMode === "mock" || !enableMutations) {
      const shouldAdvanceMockScan = !decision.dryRun && latestScanMode === "mock";
      if (shouldAdvanceMockScan) {
        state.analysis = removeCompletedGroup(state.analysis!, decision.groupId);
        state.dryRunKey = undefined;
        state.skippedGroups = state.skippedGroups.filter((groupId) => groupId !== decision.groupId);
      } else if (decision.dryRun || latestScanMode === "live") {
        state.dryRunKey = dryRunKeyFor(decision, plan.actions);
      }

      return {
        plan,
        results: plan.actions.map((action) => ({
          itemId: action.itemId,
          action: action.type,
          ok: true,
          dryRun: true
        })),
        dryRun: true,
        dryRunKey: decision.dryRun || (!enableMutations && latestScanMode === "live") ? state.dryRunKey : undefined,
        completedGroupId: shouldAdvanceMockScan ? decision.groupId : undefined,
        scan: shouldAdvanceMockScan && state.analysis ? analysisResultResponse(state, state.analysis) : undefined
      };
    }

    const requiredDryRunKey = dryRunKeyFor(decision, plan.actions);
    if (decision.confirmedDryRunKey !== requiredDryRunKey || state.dryRunKey !== requiredDryRunKey) {
      return {
        plan,
        results: [],
        blocked: true,
        error: "执行真实变更前，请先成功试运行当前计划。"
      };
    }

    if (
      plan.requiresExplicitDeleteConfirmation &&
      decision.permanentDeleteConfirmationPhrase !== permanentDeleteConfirmationPhrase
    ) {
      return {
        plan,
        results: [],
        blocked: true,
        error: `永久删除需要输入“${permanentDeleteConfirmationPhrase}”确认。`
      };
    }

    if (activeMutationScanId) {
      return {
        plan,
        results: [],
        blocked: true,
        error: "当前已有执行任务正在运行，请等待完成后重新扫描再继续。"
      };
    }
    if (hasActiveScanJob()) {
      return {
        plan,
        results: [],
        blocked: true,
        error: "当前仍有扫描任务运行中，请等待扫描完成并重新分析后再执行真实变更。"
      };
    }

    activeMutationScanId = decision.scanId;
    try {
      const involvedVaultIds = planAffectedVaultIds(plan.actions);
      const beforeStates = await snapshotVaultStates(involvedVaultIds, onePassword);
      const results = await executePlanActions(plan.actions, state.analysis!, onePassword);
      const hasFailure = results.some((result) => !result.ok);
      const hasMutation = results.some((result) => result.ok && result.action !== "keep");
      if (hasFailure) {
        latestScan = undefined;
        latestScanMode = undefined;
        latestScanAccountName = undefined;
        resetTabAnalysisState(state);
        return { plan, results, scanInvalidated: true };
      }

      const verification = await verifyExecutedPlan(plan.actions, state.analysis!, results, beforeStates, involvedVaultIds, onePassword);
      if (!verification.ok) {
        latestScan = undefined;
        latestScanMode = undefined;
        latestScanAccountName = undefined;
        resetTabAnalysisState(state);
        return { plan, results, verification, scanInvalidated: true };
      }

      state.analysis = removeCompletedGroup(state.analysis!, decision.groupId);
      state.dryRunKey = undefined;
      state.skippedGroups = state.skippedGroups.filter((groupId) => groupId !== decision.groupId);
      return {
        plan,
        results,
        verification,
        completedGroupId: decision.groupId,
        scan: analysisResultResponse(state, state.analysis),
        scanInvalidated: false,
        mutated: hasMutation
      };
    } finally {
      activeMutationScanId = undefined;
    }
  });

  async function runExecutionJob(
    job: ExecutionJob,
    state: TabAnalysisState,
    decision: DecisionBody,
    plan: ReturnType<typeof createPlanFromLatestScan>,
    dryRun: boolean
  ): Promise<void> {
    const totalOperations = plan.actions.filter((action) => action.type !== "keep").length;
    let completedOperations = 0;
    const emitActionStarted = (action: PlanAction): void => {
      if (action.type === "keep") {
        return;
      }
      emitExecutionEvent(job, {
        type: "action-started",
        executionId: job.executionId,
        dryRun,
        totalOperations,
        completedOperations,
        action: {
          itemId: action.itemId,
          type: action.type
        }
      });
    };
    const emitAction = (result: ExecuteActionResult): void => {
      if (result.action === "keep") {
        return;
      }
      completedOperations += 1;
      emitExecutionEvent(job, {
        type: "action",
        executionId: job.executionId,
        dryRun,
        totalOperations,
        completedOperations,
        result
      });
    };

    emitExecutionEvent(job, {
      type: "started",
      executionId: job.executionId,
      dryRun,
      totalOperations,
      completedOperations
    });

    try {
      if (plan.blockers.length > 0) {
        emitExecutionEvent(job, {
          type: "completed",
          executionId: job.executionId,
          dryRun,
          totalOperations,
          completedOperations,
          response: { plan, results: [], blocked: true }
        });
        return;
      }

      if (dryRun) {
        const results = plan.actions.map((action) => ({
          itemId: action.itemId,
          action: action.type,
          ok: true,
          dryRun: true
        }));
        for (let index = 0; index < results.length; index += 1) {
          emitActionStarted(plan.actions[index]);
          const result = results[index];
          emitAction(result);
        }
        emitExecutionEvent(job, {
          type: "completed",
          executionId: job.executionId,
          dryRun,
          totalOperations,
          completedOperations,
          response: { plan, results, dryRun: true }
        });
        return;
      }

      if (
        plan.requiresExplicitDeleteConfirmation &&
        decision.permanentDeleteConfirmationPhrase !== permanentDeleteConfirmationPhrase
      ) {
        emitExecutionEvent(job, {
          type: "completed",
          executionId: job.executionId,
          dryRun,
          totalOperations,
          completedOperations,
          response: {
            plan,
            results: [],
            blocked: true,
            error: `永久删除需要输入“${permanentDeleteConfirmationPhrase}”确认。`
          }
        });
        return;
      }

      const involvedVaultIds = planAffectedVaultIds(plan.actions);
      const beforeStates = await snapshotVaultStates(involvedVaultIds, onePassword);
      const results = await executePlanActions(plan.actions, state.analysis!, onePassword, emitAction, emitActionStarted);
      const hasFailure = results.some((result) => !result.ok);
      const hasMutation = results.some((result) => result.ok && result.action !== "keep");
      if (hasFailure) {
        latestScan = undefined;
        latestScanMode = undefined;
        latestScanAccountName = undefined;
        resetTabAnalysisState(state);
        emitExecutionEvent(job, {
          type: "completed",
          executionId: job.executionId,
          dryRun,
          totalOperations,
          completedOperations,
          response: { plan, results, scanInvalidated: true }
        });
        return;
      }

      const verification = await verifyExecutedPlan(plan.actions, state.analysis!, results, beforeStates, involvedVaultIds, onePassword);
      if (!verification.ok) {
        latestScan = undefined;
        latestScanMode = undefined;
        latestScanAccountName = undefined;
        resetTabAnalysisState(state);
        emitExecutionEvent(job, {
          type: "completed",
          executionId: job.executionId,
          dryRun,
          totalOperations,
          completedOperations,
          response: { plan, results, verification, scanInvalidated: true }
        });
        return;
      }

      state.analysis = removeCompletedGroup(state.analysis!, decision.groupId);
      state.dryRunKey = undefined;
      state.skippedGroups = state.skippedGroups.filter((groupId) => groupId !== decision.groupId);
      emitExecutionEvent(job, {
        type: "completed",
        executionId: job.executionId,
        dryRun,
        totalOperations,
        completedOperations,
        response: {
          plan,
          results,
          verification,
          completedGroupId: decision.groupId,
          scan: analysisResultResponse(state, state.analysis),
          scanInvalidated: false,
          mutated: hasMutation
        }
      });
    } catch (error) {
      emitExecutionEvent(job, {
        type: "failed",
        executionId: job.executionId,
        dryRun,
        totalOperations,
        completedOperations,
        error: errorMessage(error)
      });
    } finally {
      activeMutationScanId = undefined;
    }
  }

  async function runActionExecution(job: ActionExecutionJob, state: TabAnalysisState): Promise<void> {
    emitActionExecutionEvent(job, { type: "started" });
    let executionError: string | undefined;
    try {
      for (const group of job.plan.groups) {
        if (job.stopRequested) {
          break;
        }
        await waitWhilePaused(job);
        if (job.stopRequested) {
          break;
        }

        emitActionExecutionEvent(job, { type: "group-started", groupId: group.groupId });
        const involvedVaultIds = planAffectedVaultIds(group.actions);
        const beforeStates = job.plan.writeEnabled
          ? await snapshotVaultStates(involvedVaultIds, onePassword)
          : new Map<string, ItemStateSnapshot>();
        const groupResults: ExecuteActionResult[] = group.actions
          .filter((action) => action.type === "keep")
          .map((action) => ({ itemId: action.itemId, action: action.type, ok: true, dryRun: !job.plan.writeEnabled }));

        for (const entry of job.queue.filter((candidate) => candidate.groupId === group.groupId)) {
          if (job.stopRequested) {
            break;
          }
          await waitWhilePaused(job);
          if (job.stopRequested) {
            break;
          }

          job.runningAction = true;
          job.status = "running";
          job.cursor = job.queue.indexOf(entry);
          entry.status = "running";
          emitActionExecutionEvent(job, {
            type: "action-started",
            groupId: group.groupId,
            entryId: entry.entryId,
            action: { itemId: entry.action.itemId, type: entry.action.type }
          });
          const result = await executeActionPlanEntry(entry.action, state.analysis!, onePassword, job.plan.writeEnabled);
          job.runningAction = false;
          entry.result = result;
          entry.status = result.ok ? "completed" : "failed";
          job.results.push(result);
          groupResults.push(result);
          const createdItemId = entry.action.type === "copy-to-vault-and-archive-source" && result.createdItemId
            ? `${entry.action.targetVaultId}:${result.createdItemId}`
            : result.createdItemId;
          job.effects.push({
            groupId: group.groupId,
            sourceItemId: entry.action.itemId,
            createdItemId,
            createdOnePasswordItemId: result.createdItemId,
            actionType: entry.action.type,
            wroteToOnePassword: job.plan.writeEnabled && result.ok,
            succeeded: result.ok
          });
          emitActionExecutionEvent(job, {
            type: result.ok ? "action-completed" : "action-failed",
            groupId: group.groupId,
            entryId: entry.entryId,
            result
          });
          if (!result.ok) {
            executionError = result.error ?? "执行操作失败。";
            break;
          }
          if (job.pauseRequested) {
            enterPaused(job);
          }
        }

        await waitWhilePaused(job);
        if (executionError || job.stopRequested) {
          break;
        }
        emitActionExecutionEvent(job, { type: "group-verifying", groupId: group.groupId });
        if (job.plan.writeEnabled) {
          const verification = await verifyExecutedPlan(group.actions, state.analysis!, groupResults, beforeStates, involvedVaultIds, onePassword);
          if (!verification.ok) {
            executionError = verification.results.find((result) => !result.ok)?.message ?? "执行后核验失败。";
            break;
          }
        }
        emitActionExecutionEvent(job, { type: "group-completed", groupId: group.groupId });
      }
    } catch (error) {
      executionError = errorMessage(error);
    }

    for (const entry of job.queue) {
      if (entry.status === "pending") {
        entry.status = "cancelled";
      }
    }
    job.status = job.stopRequested ? "refreshing-after-stop" : "refreshing";
    emitActionExecutionEvent(job, { type: "refresh-started" });
    try {
      const refreshed = refreshAfterActionExecution(job, state);
      emitActionExecutionEvent(job, { type: "refreshed", response: refreshed });
      job.status = job.stopRequested ? "stopped" : executionError ? "failed" : "completed";
      emitActionExecutionEvent(job, {
        type: job.status,
        error: executionError,
        response: refreshed
      });
    } catch (error) {
      job.status = "failed";
      emitActionExecutionEvent(job, { type: "failed", error: errorMessage(error) });
    } finally {
      job.done = true;
      activeMutationScanId = undefined;
    }
  }

  function refreshAfterActionExecution(job: ActionExecutionJob, state: TabAnalysisState): Record<string, unknown> {
    if (!latestScan || !state.analysis) {
      throw new ClientInputError("当前分析结果已过期，请重新扫描并重新分析后再继续。");
    }
    const refreshedScan = job.plan.writeEnabled
      ? projectScanAfterActionExecution(latestScan, job)
      : latestScan;
    const analysis = job.plan.writeEnabled
      ? analyzeScan(refreshedScan)
      : state.analysis;
    latestScan = refreshedScan;
    state.analysis = analysis;
    state.dryRunKey = undefined;
    state.skippedGroups = state.skippedGroups.filter((groupId) => analysis.groups.some((group) => group.id === groupId));
    const draft = reconcileActionDraft(job.draft, analysis, job.effects);
    return {
      scan: analysisResultResponse(state, analysis),
      draft,
      results: job.results,
      effects: job.effects,
      cancelledOperations: job.queue.filter((entry) => entry.status === "cancelled").length
    };
  }

  function activeActionExecution(): ActionExecutionJob | undefined {
    return Array.from(actionExecutionJobs.values()).find((job) => !job.done);
  }

  function actionExecutionFor(executionId: string): ActionExecutionJob {
    const job = actionExecutionJobs.get(executionId);
    if (!job) {
      throw new ClientInputError("找不到执行任务，请重新开始应用计划。");
    }
    return job;
  }

  function runMockScanJob(job: ScanJob): void {
    const mockResult = createMockScanResult();
    const snapshot: ScanSnapshot = {
      scanId: job.scanId,
      scannedAt: mockResult.scannedAt,
      vaults: mockResult.vaults,
      items: []
    };

    if (job.cancelled) {
      return;
    }
    job.progress = progressFor(job.scanId, "scanning", snapshot.vaults, snapshot.items, mockResult.items.length, 0, "正在读取演示数据。");
    emitScanEvent(job, { type: "progress", progress: job.progress });

    for (const item of mockResult.items) {
      if (job.cancelled) {
        return;
      }
      snapshot.items.push(item);
      job.progress = progressFor(job.scanId, "scanning", snapshot.vaults, snapshot.items, mockResult.items.length, 0, "正在读取演示数据。");
      emitScanEvent(job, { type: "progress", progress: job.progress });
    }

    if (job.cancelled) {
      return;
    }
    latestScan = snapshot;
    latestScanMode = "mock";
    latestScanAccountName = undefined;
    job.progress = progressFor(job.scanId, "completed", snapshot.vaults, snapshot.items, mockResult.items.length, snapshot.vaults.length, "扫描完成，等待手动分析。");
    emitScanEvent(job, {
      type: "completed",
      progress: job.progress,
      scan: redactScanSnapshotForClient(snapshot)
    });
  }

  async function runLiveScanJob(job: ScanJob, accountName: string | undefined): Promise<void> {
    try {
      const scan = await onePassword.scan({
        scanId: job.scanId,
        serviceAccountToken: config.serviceAccountToken,
        accountName,
        onProgress: (event) => {
          if (job.cancelled) {
            return;
          }
          logScanProgress(server, event);
          emitScanEvent(job, redactScanProgressEvent(event));
        }
      });
      if (job.cancelled) {
        return;
      }
      const normalizedScan: ScanSnapshot = {
        ...scan,
        scanId: job.scanId
      };
      latestScan = normalizedScan;
      latestScanMode = "live";
      latestScanAccountName = config.serviceAccountToken ? undefined : accountName;
      if (!job.done) {
        job.progress = progressFor(
          job.scanId,
          "completed",
          normalizedScan.vaults,
          normalizedScan.items,
          normalizedScan.items.length,
          normalizedScan.vaults.length,
          "扫描完成，等待手动分析。"
        );
        emitScanEvent(job, {
          type: "completed",
          progress: job.progress,
          scan: redactScanSnapshotForClient(normalizedScan)
        });
      }
    } catch (error) {
      if (job.cancelled) {
        return;
      }
      const message = formatOnePasswordError(error);
      server.log.warn(
        {
          scanId: job.scanId,
          phase: "failed",
          message
        },
        "scan progress"
      );
      job.progress = {
        ...job.progress,
        phase: "failed",
        message,
        error: message
      };
      emitScanEvent(job, {
        type: "failed",
        progress: job.progress,
        error: message
      });
    }
  }

  await registerStaticUi(server, config.webDistDir);
  refreshIdleTimer();

  return server;

  function hasActiveWork(): boolean {
    return Boolean(activeMutationScanId) || hasActiveScanJob() || Boolean(activeActionExecution());
  }

  function hasActiveScanJob(): boolean {
    return Array.from(scanJobs.values()).some((job) => !job.done);
  }

  function refreshIdleTimer(): void {
    if (!config.idleShutdownMs || !canShutdown) {
      return;
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      if (hasActiveWork()) {
        refreshIdleTimer();
        return;
      }
      scheduleShutdown("idle");
    }, config.idleShutdownMs);
    idleTimer.unref();
  }

  function scheduleShutdown(reason: "requested" | "idle"): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }

    setImmediate(() => {
      void (async () => {
        if (options.lifecycle?.shutdown?.onShutdown) {
          await options.lifecycle.shutdown.onShutdown(reason);
          return;
        }
        await server.close();
      })();
    });
  }
}

function sessionMode(config: ApiConfig): AppMode {
  return config.mode ?? "browser-dev";
}

function sessionCapabilities(
  mode: AppMode,
  canShutdown: boolean,
  hasStaticUi: boolean,
  idleShutdownMs: number | undefined
) {
  return {
    staticUi: mode !== "browser-dev" && hasStaticUi,
    canShutdown,
    supportsHeartbeat: canShutdown,
    supportsIdleShutdown: canShutdown && Boolean(idleShutdownMs),
    supportsDesktopAuth: true,
    shell: mode === "tauri" ? "tauri" : "browser"
  };
}

const scanBodySchema = z.object({
  accountName: z.string().min(1).optional(),
  mode: z.enum(["live", "mock"]).default("live")
});

const scanEventsQuerySchema = z.object({
  scanId: z.string().min(1),
  eventsToken: z.string().min(1),
  after: z.coerce.number().int().min(0).default(0)
});

const executionEventsQuerySchema = z.object({
  executionId: z.string().min(1),
  eventsToken: z.string().min(1),
  after: z.coerce.number().int().min(0).default(0)
});

const actionExecutionParamsSchema = z.object({ executionId: z.string().min(1) });

const actionExecutionEventsQuerySchema = z.object({
  eventsToken: z.string().min(1),
  after: z.coerce.number().int().min(0).default(0)
});

const analyzeBodySchema = z.object({
  scanId: z.string().min(1)
});

const itemSearchBodySchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(120)).min(1).max(20)
});

const groupParamsSchema = z.object({
  groupId: z.string().min(1)
});

const itemParamsSchema = z.object({
  itemId: z.string().min(1)
});

const revealBodySchema = z.object({
  scanId: z.string().min(1)
});

const skipGroupBodySchema = z.object({
  scanId: z.string().min(1)
});

const restoreSkippedBodySchema = z.object({
  scanId: z.string().min(1)
});

function tabIdFor(request: FastifyRequest): string {
  const value = request.headers["x-tab-id"];
  const raw = Array.isArray(value) ? value[0] : value;
  const tabId = typeof raw === "string" ? raw.trim() : "";
  return tabId || "default";
}

function resetTabAnalysisState(state: TabAnalysisState): void {
  state.analysis = undefined;
  state.dryRunKey = undefined;
  state.skippedGroups = [];
}

const decisionSchema = z.object({
  scanId: z.string().min(1),
  groupId: z.string(),
  confirmPermanentDelete: z.boolean().optional(),
  permanentDeleteConfirmationPhrase: z.string().optional(),
  confirmedDryRunKey: z.string().optional(),
  dryRun: z.boolean().optional(),
  items: z.array(
    z.object({
      itemId: z.string(),
      keep: z.boolean(),
      targetVaultId: z.string().optional(),
      deleteMode: z.enum(["archive", "delete"]).optional(),
      removeTags: z.array(z.string().min(1)).optional()
    })
  )
});

const actionDraftItemSchema = z.object({
  itemId: z.string().min(1),
  keep: z.boolean(),
  targetVaultId: z.string().optional(),
  deleteMode: z.enum(["archive", "delete"]).optional(),
  removeTags: z.array(z.string().min(1)).default([])
});

const actionExecutionStartSchema = z.object({
  draft: z.object({
    scanId: z.string().min(1),
    groups: z.array(z.object({
      groupId: z.string().min(1),
      items: z.array(actionDraftItemSchema)
    })).min(1)
  }),
  permanentDeleteConfirmationPhrase: z.string().optional()
});

function createScanId(): string {
  return randomUUID();
}

function createScanJob(scanId: string, mode: ScanMode): ScanJob {
  const progress: ScanProgress = {
    scanId,
    phase: "scanning",
    totalVaults: 0,
    scannedVaults: 0,
    totalItems: 0,
    scannedItems: 0,
    vaults: [],
    message: mode === "mock" ? "正在准备演示数据。" : "正在等待 1Password 授权。"
  };
  const job: ScanJob = {
    scanId,
    mode,
    eventsToken: randomUUID(),
    progress,
    events: [],
    subscribers: new Set(),
    done: false,
    cancelled: false
  };
  emitScanEvent(job, { type: "started", progress });
  return job;
}

function createExecutionJob(executionId: string): ExecutionJob {
  return {
    executionId,
    eventsToken: randomUUID(),
    events: [],
    subscribers: new Set(),
    done: false
  };
}

function createActionExecutionJob(executionId: string, tabId: string, draft: ActionDraft, plan: ActionPlan): ActionExecutionJob {
  const queue = plan.groups.flatMap((group, groupIndex) => group.actions
    .filter((action) => action.type !== "keep")
    .map((action, actionIndex) => ({
      entryId: randomUUID(),
      groupId: group.groupId,
      groupIndex,
      actionIndex,
      action,
      status: "pending" as const
    })));
  return {
    executionId,
    tabId,
    eventsToken: randomUUID(),
    draft,
    plan,
    queue,
    cursor: 0,
    status: "running",
    pauseRequested: false,
    stopRequested: false,
    runningAction: false,
    results: [],
    effects: [],
    events: [],
    subscribers: new Set(),
    resumeWaiters: new Set(),
    done: false
  };
}

function actionExecutionSnapshot(job: ActionExecutionJob, includeCredentials = false): Record<string, unknown> {
  return {
    executionId: job.executionId,
    eventsToken: includeCredentials ? job.eventsToken : undefined,
    status: job.status,
    writeEnabled: job.plan.writeEnabled,
    totalGroups: job.plan.groups.length,
    totalOperations: job.queue.length,
    completedOperations: job.queue.filter((entry) => entry.status === "completed").length,
    cancelledOperations: job.queue.filter((entry) => entry.status === "cancelled").length,
    plan: job.plan,
    draft: job.draft
  };
}

function emitActionExecutionEvent(job: ActionExecutionJob, event: Partial<ActionExecutionEvent> & { type: string }): void {
  const sequenced: ActionExecutionEvent = {
    executionId: job.executionId,
    status: job.status,
    writeEnabled: job.plan.writeEnabled,
    totalGroups: job.plan.groups.length,
    totalOperations: job.queue.length,
    completedOperations: job.queue.filter((entry) => entry.status === "completed").length,
    sequence: job.events.length + 1,
    ...event
  };
  job.events.push(sequenced);
  for (const subscriber of job.subscribers) {
    subscriber(sequenced);
  }
}

function enterPaused(job: ActionExecutionJob): void {
  if (job.stopRequested || job.status === "paused") {
    return;
  }
  job.status = "paused";
  emitActionExecutionEvent(job, { type: "paused" });
}

async function waitWhilePaused(job: ActionExecutionJob): Promise<void> {
  if (job.pauseRequested && !job.stopRequested) {
    enterPaused(job);
  }
  if (job.status !== "paused") {
    return;
  }
  await new Promise<void>((resolve) => job.resumeWaiters.add(resolve));
}

function terminalActionExecution(status: ActionExecutionStatus): boolean {
  return status === "stopped" || status === "completed" || status === "failed";
}

function cancelScanJobs(scanJobs: Map<string, ScanJob>): void {
  for (const job of scanJobs.values()) {
    if (job.done || job.cancelled) {
      continue;
    }

    job.cancelled = true;
    emitScanEvent(job, {
      type: "failed",
      error: "扫描已取消。",
      progress: {
        ...job.progress,
        phase: "failed",
        message: "扫描已取消。",
        error: "扫描已取消。"
      }
    });
  }
}

function emitScanEvent(job: ScanJob, event: ScanProgressEvent): void {
  job.progress = event.progress;
  job.events.push(event);
  for (const subscriber of job.subscribers) {
    subscriber(event);
  }
  if (event.type === "completed" || event.type === "failed") {
    job.done = true;
  }
}

function emitExecutionEvent(job: ExecutionJob, event: Omit<ExecutionProgressEvent, "sequence">): void {
  const sequencedEvent: ExecutionProgressEvent = {
    ...event,
    sequence: job.events.length + 1
  };
  job.events.push(sequencedEvent);
  for (const subscriber of job.subscribers) {
    subscriber(sequencedEvent);
  }
  if (sequencedEvent.type === "completed" || sequencedEvent.type === "failed") {
    job.done = true;
  }
}

function isAuthorizedEventStream(
  url: string,
  scanJobs: Map<string, ScanJob>,
  executionJobs: Map<string, ExecutionJob>,
  actionExecutionJobs: Map<string, ActionExecutionJob>
): boolean {
  const parsed = new URL(url, "http://127.0.0.1");
  const eventsToken = parsed.searchParams.get("eventsToken");
  if (!eventsToken) {
    return false;
  }

  if (parsed.pathname === "/api/scan/events") {
    const scanId = parsed.searchParams.get("scanId");
    return scanId !== null && scanJobs.get(scanId)?.eventsToken === eventsToken;
  }
  if (parsed.pathname === "/api/execute/events") {
    const executionId = parsed.searchParams.get("executionId");
    return executionId !== null && executionJobs.get(executionId)?.eventsToken === eventsToken;
  }
  const actionExecutionMatch = parsed.pathname.match(/^\/api\/action-executions\/([^/]+)\/events$/);
  if (actionExecutionMatch) {
    return actionExecutionJobs.get(decodeURIComponent(actionExecutionMatch[1]))?.eventsToken === eventsToken;
  }
  return false;
}

function corsHeadersFor(origin: string | undefined, allowedOrigins: string[]): Record<string, string> {
  if (!origin) {
    return {};
  }
  if (!allowedOrigins.includes(origin)) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    vary: "Origin"
  };
}

function logScanProgress(server: FastifyInstance, event: ScanProgressEvent): void {
  const message = event.progress.message ?? event.error;
  if (!message) {
    return;
  }

  const logPayload = {
    scanId: event.progress.scanId,
    eventType: event.type,
    phase: event.progress.phase,
    totalVaults: event.progress.totalVaults,
    scannedVaults: event.progress.scannedVaults,
    totalItems: event.progress.totalItems,
    scannedItems: event.progress.scannedItems,
    message,
    error: event.error ?? event.progress.error
  };
  if (event.type === "failed" || event.progress.error || /无法|跳过|超过|失败/.test(message)) {
    server.log.warn(logPayload, "scan progress");
    return;
  }
  if (/连接|唤起|授权|保险库列表|项目列表|项目详情|已发现|已读取|扫描完成/.test(message)) {
    server.log.info(logPayload, "scan progress");
  }
}

function progressFor(
  scanId: string,
  phase: ScanProgress["phase"],
  vaults: ScanSnapshot["vaults"],
  items: ScanSnapshot["items"],
  totalItems: number,
  scannedVaults: number,
  message?: string
): ScanProgress {
  return {
    scanId,
    phase,
    totalVaults: vaults.length,
    scannedVaults,
    totalItems,
    scannedItems: items.length,
    vaults: summarizeVaults(vaults, items),
    message
  };
}

function redactScanProgressEvent(event: ScanProgressEvent): ScanProgressEvent {
  return {
    ...event,
    scan: event.scan ? redactScanSnapshotForClient(event.scan) : undefined
  };
}

function toSseMessage(event: { type: string; sequence?: number }): string {
  const id = event.sequence ? `id: ${event.sequence}\n` : "";
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function lastEventSequence(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const sequence = Number.parseInt(raw ?? "0", 10);
  return Number.isFinite(sequence) && sequence > 0 ? sequence : 0;
}

function analyzeScan(scan: ScanSnapshot): ScanResult {
  return {
    ...scan,
    analyzedAt: new Date().toISOString(),
    groups: findDuplicateGroups(scan.items)
  };
}

function mockRevealCredentials(itemId: string): RevealedCredentialField[] {
  return [
    {
      label: "凭据材料",
      value: `mock-secret-for-${itemId.split(":").at(-1) ?? "item"}`,
      fieldType: "mock-concealed"
    }
  ];
}

function createPlanFromLatestScan(decision: GroupDecision, latestScan: ScanResult | undefined) {
  const scan = currentAnalysisFor(decision.scanId, latestScan);

  const group = scan.groups.find((candidate) => candidate.id === decision.groupId);
  if (!group) {
    throw new ClientInputError(`找不到重复组：${decision.groupId}`);
  }

  const consistencyBlockers = validateDecisionItemSet(decision, group.itemIds);
  const planDecision = {
    ...decision,
    items: decision.items.filter((item) => group.itemIds.includes(item.itemId))
  };
  const plan = createExecutionPlan(decision.groupId, planDecision, scan.items, {
    requireKeep: group.candidateClass !== "delete-suggestion"
  });
  const targetVaultBlockers = validateTargetVaults(decision, scan);
  return {
    ...plan,
    blockers: Array.from(new Set([...plan.blockers, ...consistencyBlockers, ...targetVaultBlockers]))
  };
}

function currentScanSnapshotFor(scanId: string, latestScan: ScanSnapshot | undefined): ScanSnapshot {
  if (!latestScan) {
    throw new ClientInputError("请先运行扫描。");
  }

  if (scanId !== latestScan.scanId) {
    throw new ClientInputError("当前扫描结果已过期，请重新扫描后再继续。");
  }

  return latestScan;
}

function currentAnalysisFor(scanId: string, latestAnalysis: ScanResult | undefined): ScanResult {
  if (!latestAnalysis) {
    throw new ClientInputError("请先完成扫描并手动运行分析。");
  }

  if (scanId !== latestAnalysis.scanId) {
    throw new ClientInputError("当前分析结果已过期，请重新扫描并重新分析后再继续。");
  }

  return latestAnalysis;
}

function currentAnalysisForGlobalScan(analysis: ScanResult, latestScan: ScanSnapshot | undefined): ScanResult {
  if (!latestScan) {
    throw new ClientInputError("当前扫描结果已过期，请重新扫描并重新分析后再继续。");
  }

  if (analysis.scanId !== latestScan.scanId) {
    throw new ClientInputError("当前分析结果已过期，请基于最新扫描重新分析后再继续。");
  }

  return analysis;
}

function validateTargetVaults(decision: ActionDraftGroup, scan: ScanResult): string[] {
  const vaultIds = new Set(scan.vaults.map((vault) => vault.id));
  const blockers: string[] = [];

  for (const itemDecision of decision.items) {
    if (!itemDecision.keep || !itemDecision.targetVaultId) {
      continue;
    }
    if (!vaultIds.has(itemDecision.targetVaultId)) {
      blockers.push(`目标保险库不存在或不可访问：${itemDecision.targetVaultId}`);
    }
  }

  return blockers;
}

class ClientInputError extends Error {
}

async function executePlanActions(
  actions: PlanAction[],
  latestScan: ScanResult,
  onePassword: PasswordService,
  onResult?: (result: ExecuteActionResult) => void,
  onActionStarted?: (action: PlanAction) => void
): Promise<ExecuteActionResult[]> {
  const itemById = new Map(latestScan.items.map((item) => [item.id, item]));
  const results: ExecuteActionResult[] = [];
  const append = (result: ExecuteActionResult): void => {
    results.push(result);
    onResult?.(result);
  };

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    onActionStarted?.(action);
    if (action.type === "keep") {
      append({ itemId: action.itemId, action: action.type, ok: true });
      continue;
    }

    const item = itemById.get(action.itemId);
    if (!item) {
      append({ itemId: action.itemId, action: action.type, ok: false, error: "找不到要处理的项目。" });
      for (const result of skippedResults(actions.slice(index + 1))) {
        append(result);
      }
      break;
    }

    try {
      if (action.type === "update-tags") {
        await onePassword.removeTags(item.id, action.removeTags);
      } else if (action.type === "archive") {
        await onePassword.archive(item.vaultId, item.onePasswordItemId);
      } else if (action.type === "delete") {
        await onePassword.delete(item.vaultId, item.onePasswordItemId);
      } else if (action.type === "copy-to-vault-and-archive-source") {
        const copyResult = await onePassword.copyToVaultAndArchiveSource(item.id, action.targetVaultId, action.removeTags);
        append({
          itemId: action.itemId,
          action: action.type,
          ok: true,
          createdItemId: copyResult.createdItemId,
          targetVaultId: action.targetVaultId
        });
        continue;
      }
      append({ itemId: action.itemId, action: action.type, ok: true });
    } catch (error) {
      append({
        itemId: action.itemId,
        action: action.type,
        ok: false,
        error: mutationActionError(action, error)
      });
      for (const result of skippedResults(actions.slice(index + 1))) {
        append(result);
      }
      break;
    }
  }

  return results;
}

async function executeActionPlanEntry(
  action: PlanAction,
  scan: ScanResult,
  onePassword: PasswordService,
  writeEnabled: boolean
): Promise<ExecuteActionResult> {
  const item = scan.items.find((candidate) => candidate.id === action.itemId);
  if (!item) {
    return { itemId: action.itemId, action: action.type, ok: false, error: "找不到要处理的项目。" };
  }
  if (!writeEnabled) {
    return { itemId: action.itemId, action: action.type, ok: true, dryRun: true };
  }
  try {
    if (action.type === "update-tags") {
      await onePassword.removeTags(item.id, action.removeTags);
    } else if (action.type === "archive") {
      await onePassword.archive(item.vaultId, item.onePasswordItemId);
    } else if (action.type === "delete") {
      await onePassword.delete(item.vaultId, item.onePasswordItemId);
    } else if (action.type === "copy-to-vault-and-archive-source") {
      const copy = await onePassword.copyToVaultAndArchiveSource(item.id, action.targetVaultId, action.removeTags);
      return {
        itemId: action.itemId,
        action: action.type,
        ok: true,
        createdItemId: copy.createdItemId,
        targetVaultId: action.targetVaultId
      };
    }
    return { itemId: action.itemId, action: action.type, ok: true };
  } catch (error) {
    return { itemId: action.itemId, action: action.type, ok: false, error: mutationActionError(action, error) };
  }
}

function projectScanAfterActionExecution(scan: ScanSnapshot, job: ActionExecutionJob): ScanSnapshot {
  const effects = job.effects.filter((effect) => effect.wroteToOnePassword && effect.succeeded);
  if (effects.length === 0) {
    return scan;
  }

  const actionByEffect = new Map(job.queue.map((entry) => [
    `${entry.action.itemId}:${entry.action.type}`,
    entry.action
  ]));
  const items = new Map(scan.items.map((item) => [item.id, item]));
  const vaultById = new Map(scan.vaults.map((vault) => [vault.id, vault]));
  const projectedAt = new Date().toISOString();

  for (const effect of effects) {
    const action = actionByEffect.get(`${effect.sourceItemId}:${effect.actionType}`);
    const source = items.get(effect.sourceItemId);
    if (!action || !source) {
      continue;
    }

    if (action.type === "update-tags") {
      const removedTags = new Set(action.removeTags);
      items.set(source.id, {
        ...source,
        tags: source.tags.filter((tag) => !removedTags.has(tag)),
        updatedAt: projectedAt
      });
      continue;
    }

    if (action.type === "archive" || action.type === "delete") {
      items.delete(source.id);
      continue;
    }

    if (action.type === "copy-to-vault-and-archive-source" && effect.createdItemId && effect.createdOnePasswordItemId) {
      const removedTags = new Set(action.removeTags);
      const targetVault = vaultById.get(action.targetVaultId);
      items.delete(source.id);
      items.set(effect.createdItemId, {
        ...source,
        id: effect.createdItemId,
        onePasswordItemId: effect.createdOnePasswordItemId,
        vaultId: action.targetVaultId,
        vaultName: targetVault?.name ?? action.targetVaultId,
        createdAt: projectedAt,
        updatedAt: projectedAt,
        tags: source.tags.filter((tag) => !removedTags.has(tag))
      });
    }
  }

  return {
    scanId: createScanId(),
    scannedAt: projectedAt,
    vaults: scan.vaults,
    items: Array.from(items.values())
  };
}

function reconcileActionDraft(draft: ActionDraft, scan: ScanResult, effects: ActionEffect[]): ActionDraft {
  const original = new Map<string, ActionDraftItem>();
  for (const group of draft.groups) {
    for (const item of group.items) {
      original.set(item.itemId, { ...item, removeTags: [...(item.removeTags ?? [])] });
    }
  }
  for (const effect of effects.filter((candidate) => candidate.wroteToOnePassword && candidate.succeeded)) {
    const decision = original.get(effect.sourceItemId);
    if (effect.actionType === "copy-to-vault-and-archive-source" && effect.createdItemId && decision) {
      original.set(effect.createdItemId, {
        ...decision,
        itemId: effect.createdItemId,
        keep: true,
        targetVaultId: undefined,
        removeTags: []
      });
      original.delete(effect.sourceItemId);
    } else if (effect.actionType === "archive" || effect.actionType === "delete") {
      original.delete(effect.sourceItemId);
    } else if (effect.actionType === "update-tags" && decision) {
      original.set(effect.sourceItemId, { ...decision, removeTags: [] });
    }
  }

  const itemById = new Map(scan.items.map((item) => [item.id, item]));
  return {
    scanId: scan.scanId,
    groups: scan.groups.map((group) => {
      const recommended = new Set(group.recommendedKeepIds);
      const fallbackKeepId = group.itemIds[0];
      return {
        groupId: group.id,
        items: group.itemIds.map((itemId) => {
          const preserved = original.get(itemId);
          if (preserved) {
            const item = itemById.get(itemId);
            const validTarget = preserved.targetVaultId && scan.vaults.some((vault) => vault.id === preserved.targetVaultId)
              ? preserved.targetVaultId
              : item?.vaultId;
            return { ...preserved, itemId, targetVaultId: validTarget, removeTags: [...(preserved.removeTags ?? [])] };
          }
          const item = itemById.get(itemId)!;
          return {
            itemId,
            keep: group.candidateClass === "delete-suggestion" ? false : recommended.size ? recommended.has(itemId) : itemId === fallbackKeepId,
            targetVaultId: item.vaultId,
            deleteMode: "archive" as const,
            removeTags: []
          };
        })
      };
    })
  };
}

function skippedResults(actions: PlanAction[]): ExecuteActionResult[] {
  return actions.map((action) => ({
    itemId: action.itemId,
    action: action.type,
    ok: false,
    skipped: true,
    error: "由于前一个操作失败，已跳过。"
  }));
}

function planAffectedVaultIds(actions: PlanAction[]): string[] {
  const vaultIds = new Set<string>();
  for (const action of actions) {
    vaultIds.add(action.vaultId);
    if (action.type === "copy-to-vault-and-archive-source") {
      vaultIds.add(action.targetVaultId);
    }
  }
  return Array.from(vaultIds).sort();
}

async function snapshotVaultStates(vaultIds: string[], onePassword: PasswordService): Promise<Map<string, ItemStateSnapshot>> {
  const states = new Map<string, ItemStateSnapshot>();
  for (const vaultId of vaultIds) {
    states.set(vaultId, await onePassword.listItemStates(vaultId));
  }
  return states;
}

async function verifyExecutedPlan(
  actions: PlanAction[],
  latestScan: ScanResult,
  results: ExecuteActionResult[],
  beforeStates: Map<string, ItemStateSnapshot>,
  involvedVaultIds: string[],
  onePassword: PasswordService
): Promise<ExecutionVerification> {
  let latestVerification: ExecutionVerification = { ok: false, results: [] };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await sleep(300);
    }
    let afterStates: Map<string, ItemStateSnapshot>;
    try {
      afterStates = await snapshotVaultStates(involvedVaultIds, onePassword);
    } catch (error) {
      latestVerification = {
        ok: false,
        results: involvedVaultIds.map((vaultId) => ({
          vaultId,
          ok: false,
          severity: "incomplete",
          message: `执行后校验失败：无法读取保险库 ${vaultId} 的 item 状态：${errorMessage(error)}`
        }))
      };
      continue;
    }
    latestVerification = verifyPlanAgainstSnapshots(actions, latestScan, results, beforeStates, afterStates);
    if (latestVerification.ok) {
      return latestVerification;
    }
  }
  return latestVerification;
}

function verifyPlanAgainstSnapshots(
  actions: PlanAction[],
  latestScan: ScanResult,
  results: ExecuteActionResult[],
  beforeStates: Map<string, ItemStateSnapshot>,
  afterStates: Map<string, ItemStateSnapshot>
): ExecutionVerification {
  const itemById = new Map(latestScan.items.map((item) => [item.id, item]));
  const resultByItemId = new Map(results.map((result) => [result.itemId, result]));
  const failures: VerificationResult[] = [];
  const allowedTransitions = new Map<string, Map<string, ItemState>>();

  const allow = (vaultId: string, itemId: string, state: ItemState): void => {
    let vaultTransitions = allowedTransitions.get(vaultId);
    if (!vaultTransitions) {
      vaultTransitions = new Map<string, ItemState>();
      allowedTransitions.set(vaultId, vaultTransitions);
    }
    vaultTransitions.set(itemId, state);
  };

  for (const action of actions) {
    const item = itemById.get(action.itemId);
    if (!item) {
      failures.push({
        itemId: action.itemId,
        vaultId: action.vaultId,
        action: action.type,
        ok: false,
        severity: "critical",
        message: "执行后校验失败：找不到计划内 item 的扫描材料。"
      });
      continue;
    }

    const sourceItemId = item.onePasswordItemId;
    const sourceAfter = stateOf(afterStates.get(item.vaultId), sourceItemId);
    if (action.type === "keep") {
      allow(item.vaultId, sourceItemId, "active");
      if (sourceAfter !== "active") {
        failures.push({
          itemId: sourceItemId,
          vaultId: item.vaultId,
          action: action.type,
          ok: false,
          severity: "critical",
          message: `执行后校验失败：保留项 ${item.title} 已不在原保险库的活跃列表中。`
        });
      }
      continue;
    }

    if (action.type === "update-tags") {
      allow(item.vaultId, sourceItemId, "active");
      if (sourceAfter !== "active") {
        failures.push({
          itemId: sourceItemId,
          vaultId: item.vaultId,
          action: action.type,
          ok: false,
          severity: "critical",
          message: `执行后校验失败：标签更新项 ${item.title} 已不在原保险库的活跃列表中。`
        });
      }
      continue;
    }

    if (action.type === "archive") {
      allow(item.vaultId, sourceItemId, "archived");
      if (sourceAfter !== "archived") {
        failures.push({
          itemId: sourceItemId,
          vaultId: item.vaultId,
          action: action.type,
          ok: false,
          severity: sourceAfter === "missing" ? "critical" : "incomplete",
          message: sourceAfter === "missing"
            ? `执行后校验失败：归档项 ${item.title} 未出现在归档列表中，且已不在活跃列表中。`
            : `执行后校验失败：归档项 ${item.title} 仍在活跃列表中。`
        });
      }
      continue;
    }

    if (action.type === "delete") {
      allow(item.vaultId, sourceItemId, "missing");
      if (sourceAfter !== "missing") {
        failures.push({
          itemId: sourceItemId,
          vaultId: item.vaultId,
          action: action.type,
          ok: false,
          severity: "incomplete",
          message: `执行后校验失败：删除项 ${item.title} 仍存在于 ${sourceAfter === "active" ? "活跃" : "归档"} 列表中。`
        });
      }
      continue;
    }

    if (action.type === "copy-to-vault-and-archive-source") {
      const result = resultByItemId.get(action.itemId);
      const createdItemId = result?.createdItemId;
      allow(item.vaultId, sourceItemId, "archived");
      if (createdItemId) {
        allow(action.targetVaultId, createdItemId, "active");
      }
      if (sourceAfter !== "archived") {
        failures.push({
          itemId: sourceItemId,
          vaultId: item.vaultId,
          action: action.type,
          ok: false,
          severity: sourceAfter === "missing" ? "critical" : "incomplete",
          message: sourceAfter === "missing"
            ? `执行后校验失败：迁移源 ${item.title} 未归档且已不在原保险库中。`
            : `执行后校验失败：迁移源 ${item.title} 仍在原保险库活跃列表中。`
        });
      }
      if (!createdItemId) {
        failures.push({
          itemId: action.itemId,
          vaultId: action.targetVaultId,
          action: action.type,
          ok: false,
          severity: "critical",
          message: `执行后校验失败：迁移目标 ${item.title} 缺少新建 item id。`
        });
      } else if (stateOf(afterStates.get(action.targetVaultId), createdItemId) !== "active") {
        failures.push({
          itemId: createdItemId,
          vaultId: action.targetVaultId,
          action: action.type,
          ok: false,
          severity: "critical",
          message: `执行后校验失败：迁移目标 ${item.title} 未出现在目标保险库活跃列表中。`
        });
      }
    }
  }

  failures.push(...verifyVaultDiffs(beforeStates, afterStates, allowedTransitions));
  return {
    ok: failures.length === 0,
    results: failures
  };
}

type ItemState = "active" | "archived" | "missing";

function verifyVaultDiffs(
  beforeStates: Map<string, ItemStateSnapshot>,
  afterStates: Map<string, ItemStateSnapshot>,
  allowedTransitions: Map<string, Map<string, ItemState>>
): VerificationResult[] {
  const failures: VerificationResult[] = [];
  const vaultIds = new Set([...beforeStates.keys(), ...afterStates.keys()]);
  for (const vaultId of vaultIds) {
    const before = beforeStates.get(vaultId);
    const after = afterStates.get(vaultId);
    const itemIds = new Set([
      ...(before?.activeIds ?? []),
      ...(before?.archivedIds ?? []),
      ...(after?.activeIds ?? []),
      ...(after?.archivedIds ?? [])
    ]);
    const allowed = allowedTransitions.get(vaultId) ?? new Map<string, ItemState>();
    for (const itemId of itemIds) {
      const beforeState = stateOf(before, itemId);
      const afterState = stateOf(after, itemId);
      if (beforeState === afterState) {
        continue;
      }
      if (allowed.get(itemId) === afterState) {
        continue;
      }
      failures.push({
        itemId,
        vaultId,
        ok: false,
        severity: "critical",
        message: `执行后校验失败：保险库 ${vaultId} 中 item ${itemId} 出现计划外状态变化（${beforeState} -> ${afterState}）。`
      });
    }
  }
  return failures;
}

function stateOf(snapshot: ItemStateSnapshot | undefined, itemId: string): ItemState {
  if (snapshot?.activeIds.includes(itemId)) {
    return "active";
  }
  if (snapshot?.archivedIds.includes(itemId)) {
    return "archived";
  }
  return "missing";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mutationActionError(action: PlanAction, error: unknown): string {
  const detail = errorMessage(error);
  if (action.type === "archive") {
    return `归档失败：${detail}`;
  }
  if (action.type === "delete") {
    return `删除失败：${detail}`;
  }
  if (action.type === "copy-to-vault-and-archive-source") {
    return `迁移失败：${detail}`;
  }
  if (action.type === "update-tags") {
    return `标签更新失败：${detail}`;
  }
  return `执行失败：${detail}`;
}

function formatOnePasswordError(error: unknown): string {
  const message = errorMessage(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("you can only retrieve up to 50 items at once")) {
    return "1Password 扫描失败：SDK 一次最多只能读取 50 个项目，请更新后重新扫描。";
  }
  if (normalized.includes("account") && normalized.includes("auth")) {
    return `1Password 授权失败：请确认账户标识正确，并已在 1Password 桌面 App 中开启开发者集成。原始错误：${message}`;
  }
  return `1Password 扫描失败：${message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildItemSearchResponse(items: ItemSummary[], keywords: string[]): ItemSearchResponse {
  const normalizedKeywords = Array.from(new Set(keywords.map(normalizeLooseText).filter(Boolean)));
  const itemIds = items
    .filter((item) => normalizedKeywords.some((keyword) => itemMatchesSearchKeyword(item, keyword)))
    .map((item) => item.id);
  const categorySuggestions = categorySearchSuggestions(items, normalizedKeywords);
  const fieldSuggestions = fieldSearchSuggestions(items, normalizedKeywords);
  return {
    itemIds,
    suggestions: limitSearchSuggestions([...categorySuggestions, ...fieldSuggestions])
  };
}

interface CategorySearchCandidate {
  id: string;
  kind: Exclude<ItemSearchSuggestionKind, "field">;
  label: string;
  aliases: Set<string>;
  itemIds: Set<string>;
}

function categorySearchSuggestions(items: ItemSummary[], keywords: string[]): ItemSearchSuggestion[] {
  const candidates = new Map<string, CategorySearchCandidate>();
  for (const item of items) {
    const year = item.updatedAt ? String(new Date(item.updatedAt).getUTCFullYear()) : "未记录";
    addCategorySearchCandidate(candidates, `year:${year}`, "year", year, [year], item.id);
    addCategorySearchCandidate(candidates, `vault:${item.vaultId}`, "vault", item.vaultName, [item.vaultName, item.vaultId], item.id);
    for (const credential of credentialSearchOptions(item)) {
      addCategorySearchCandidate(candidates, `credential:${credential.id}`, "credential", credential.label, credential.aliases, item.id);
    }
    for (const domain of item.urls.map(normalizeUrlHost).filter((value): value is string => Boolean(value))) {
      addCategorySearchCandidate(candidates, `domain:${domain}`, "domain", domain, [domain], item.id);
    }
  }

  return Array.from(candidates.values())
    .filter((candidate) => Array.from(candidate.aliases).some((alias) => matchesAnyKeyword(alias, keywords)))
    .map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      label: candidate.label,
      itemIds: Array.from(candidate.itemIds),
      count: candidate.itemIds.size
    }));
}

function addCategorySearchCandidate(
  candidates: Map<string, CategorySearchCandidate>,
  id: string,
  kind: CategorySearchCandidate["kind"],
  label: string,
  aliases: string[],
  itemId: string
): void {
  const current = candidates.get(id) ?? { id, kind, label, aliases: new Set<string>(), itemIds: new Set<string>() };
  aliases.forEach((alias) => current.aliases.add(alias));
  current.itemIds.add(itemId);
  candidates.set(id, current);
}

function fieldSearchSuggestions(items: ItemSummary[], keywords: string[]): ItemSearchSuggestion[] {
  return items.flatMap((item) => matchedItemFields(item, keywords).map((field) => ({
    id: `field:${field}:${item.id}`,
    kind: "field" as const,
    label: item.title,
    field,
    itemIds: [item.id],
    count: 1
  })));
}

function matchedItemFields(item: ItemSummary, keywords: string[]): ItemSearchField[] {
  const matched = new Set<ItemSearchField>();
  if (matchesAnyKeyword(item.title, keywords)) {
    matched.add("title");
  }
  if (item.usernames.some((value) => matchesAnyKeyword(value, keywords))) {
    matched.add("username");
  }
  if (item.urls.some((value) => matchesAnyKeyword(value, keywords))) {
    matched.add("url");
  }
  if (item.comparableFields.some((field) => field.kind === "phone" && field.normalizedValue && matchesAnyKeyword(field.normalizedValue, keywords))) {
    matched.add("phone");
  }
  if (item.comparableFields.some((field) => field.kind === "email" && field.normalizedValue && matchesAnyKeyword(field.normalizedValue, keywords))) {
    matched.add("email");
  }
  const noteValues = [
    item.analysis?.notesText ?? "",
    ...item.comparableFields
      .filter((field) => isNoteField(field.label))
      .flatMap((field) => field.normalizedValue ? [field.normalizedValue] : [])
  ];
  if (noteValues.some((value) => matchesAnyKeyword(value, keywords))) {
    matched.add("note");
  }
  return Array.from(matched);
}

function limitSearchSuggestions(suggestions: ItemSearchSuggestion[]): ItemSearchSuggestion[] {
  const limits = new Map<ItemSearchSuggestionKind, number>();
  return suggestions
    .sort((left, right) => searchSuggestionOrder(left.kind) - searchSuggestionOrder(right.kind) || right.count - left.count || left.label.localeCompare(right.label))
    .filter((suggestion) => {
      const count = limits.get(suggestion.kind) ?? 0;
      limits.set(suggestion.kind, count + 1);
      return count < 8;
    });
}

function searchSuggestionOrder(kind: ItemSearchSuggestionKind): number {
  return ["year", "vault", "credential", "domain", "field"].indexOf(kind);
}

function matchesAnyKeyword(value: string, keywords: string[]): boolean {
  const normalized = normalizeLooseText(value);
  return keywords.some((keyword) => normalized.includes(keyword));
}

function itemMatchesSearchKeyword(item: ItemSummary, keyword: string): boolean {
  return searchValuesForItem(item).some((value) => normalizeLooseText(value).includes(keyword));
}

function searchValuesForItem(item: ItemSummary): string[] {
  return [
    item.updatedAt ? String(new Date(item.updatedAt).getUTCFullYear()) : "未记录",
    item.vaultName,
    ...credentialSearchLabels(item),
    ...item.urls.flatMap((url) => [url, normalizeUrlHost(url) ?? ""]),
    item.title,
    ...item.usernames,
    ...item.comparableFields
      .filter((field) => field.kind === "email" || field.kind === "phone" || isNoteField(field.label))
      .flatMap((field) => field.normalizedValue ? [field.normalizedValue] : []),
    item.analysis?.notesText ?? ""
  ];
}

function credentialSearchLabels(item: ItemSummary): string[] {
  return credentialSearchOptions(item).flatMap((credential) => credential.aliases);
}

function credentialSearchOptions(item: ItemSummary): Array<{ id: string; label: string; aliases: string[] }> {
  return [
    ...(item.hasPassword ? [{ id: "password", label: "密码", aliases: ["密码", "password"] }] : []),
    ...(item.hasTotp ? [{ id: "totp", label: "一次性密码", aliases: ["一次性密码", "totp", "one-time password"] }] : []),
    ...(item.hasPasskey ? [{ id: "passkey", label: "Passkey", aliases: ["Passkey", "passkey"] }] : [])
  ];
}

function isNoteField(label: string): boolean {
  const normalized = normalizeLooseText(label);
  return normalized.includes("note") || normalized.includes("备注");
}

function redactScanSnapshotForClient(scan: ScanSnapshot): ScanSnapshot {
  return {
    ...scan,
    items: scan.items.map((item) => ({
      ...item,
      comparableFields: item.comparableFields
        .filter((field) => field.kind === "secret")
        .map((field) => ({ label: field.label, kind: field.kind })),
      analysis: undefined
    }))
  };
}

function redactScanResultForClient(scan: ScanResult): ScanResult {
  return {
    ...redactScanSnapshotForClient(scan),
    analyzedAt: scan.analyzedAt,
    groups: scan.groups.map((group) => ({
      ...group,
      reasons: group.reasons.map((reason) => ({
        ...reason,
        key: `${reason.rule}:redacted`
      }))
    }))
  };
}

function analysisResultResponse(state: TabAnalysisState, scan: ScanResult): AnalysisResultResponse {
  return {
    ...redactScanResultForClient(scan),
    skippedGroupIds: state.skippedGroups
  };
}

function assertGroupIsNotSkipped(state: TabAnalysisState, groupId: string): void {
  if (state.skippedGroups.includes(groupId)) {
    throw new ClientInputError("该重复组已标记跳过，请先取消跳过标记。");
  }
}

function removeCompletedGroup(scan: ScanResult, groupId: string): ScanResult {
  return {
    ...scan,
    groups: scan.groups.filter((group) => group.id !== groupId)
  };
}

function dryRunKeyFor(decision: GroupDecision, actions: PlanAction[]): string {
  const canonicalPlan = {
    scanId: decision.scanId,
    groupId: decision.groupId,
    actions: actions.map((action) => ({
      type: action.type,
      itemId: action.itemId,
      vaultId: action.vaultId,
      targetVaultId: "targetVaultId" in action ? action.targetVaultId : ""
    }))
  };

  return createHash("sha256").update(JSON.stringify(canonicalPlan)).digest("base64url");
}

async function registerStaticUi(server: FastifyInstance, webDistDir: string | undefined): Promise<void> {
  if (!webDistDir || !(await directoryExists(webDistDir))) {
    return;
  }

  const root = resolve(webDistDir);
  server.get("/*", async (request, reply) => {
    const rawPath = request.url.split("?")[0] || "/";
    const decodedPath = safeDecodePath(rawPath);
    const candidatePath = decodedPath === "/" ? "/index.html" : decodedPath;
    const filePath = await resolveStaticFile(root, candidatePath);

    if (!filePath) {
      return reply.code(404).send({ error: "找不到请求的资源。" });
    }

    reply.type(contentTypeFor(filePath));
    return reply.send(createReadStream(filePath));
  });
}

async function resolveStaticFile(root: string, requestPath: string): Promise<string | undefined> {
  const relativePath = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^[/\\]+/, "");
  const requestedFile = resolve(root, relativePath);
  if (!isInside(root, requestedFile)) {
    return undefined;
  }

  if (await fileExists(requestedFile)) {
    return requestedFile;
  }

  const indexFile = join(root, "index.html");
  if (!extname(requestPath) && await fileExists(indexFile)) {
    return indexFile;
  }

  return undefined;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function safeDecodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return "/";
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.includes("..\\"));
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function securityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'"
  ].join("; ");
}
