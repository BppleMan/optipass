import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";
import cors from "@fastify/cors";
import Fastify, { FastifyInstance, FastifyRequest, FastifyServerOptions } from "fastify";
import {
  ActionDraft as CanonicalActionDraft,
  ActionExecutionEventKind,
  ActionExecutionStatus as CanonicalActionExecutionStatus,
  ActionKind,
  ActionPlan as CanonicalActionPlan,
  ActionPlanDto,
  ActionStepStatus,
  DryRunSpeedMultiplier,
  ExecutionMode,
  CanonicalItem,
  ItemDisposition,
  ItemProvider,
  normalizeLooseText,
  normalizeUrlHost,
  RevealedCredentialField,
  RevealCredentialsResponse,
  ScanProgress,
  ScanProgressEvent,
  ScanMode,
  ScanPhase,
  ScanProgressEventType,
  ScanSnapshot,
  ScanResult,
  StoreState,
  summarizeVaults,
  toActionPlanDto
} from "@optimize-password/core";
import { z, ZodError } from "zod";
import { ApiConfig, AppMode } from "./config.js";
import { ActionExecutionControl, ActionExecutionEvent as CanonicalExecutionEvent } from "./action-execution-service.js";

export interface CreateApiServerOptions {
  config: ApiConfig;
  services: import("./item-services.js").ApplicationServices;
  logger?: FastifyServerOptions["logger"];
  lifecycle?: ApiLifecycleOptions;
}

export interface ApiLifecycleOptions {
  shutdown?: {
    enabled: boolean;
    onShutdown?: (reason: ApiShutdownReason) => Promise<void>;
  };
}

export enum ApiShutdownReason {
  Requested = "requested",
  Idle = "idle",
}

const permanentDeleteConfirmationPhrase = "永久删除";
const revealExpiresInSeconds = 30;

interface ScanStartResponse {
  scanId: string;
  mode: ScanMode;
  progress: ScanProgress;
  eventsToken: string;
}

interface ActiveScanResponse extends ScanStartResponse {
  eventCount: number;
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


interface ActionExecutionEvent {
  type: ActionExecutionEventKind;
  sequence: number;
  executionId: string;
  status: CanonicalActionExecutionStatus;
  writeEnabled: boolean;
  totalGroups: number;
  totalOperations: number;
  completedOperations: number;
  groupId?: string;
  actionId?: string;
  stepStatus?: ActionStepStatus;
  message?: string;
  response?: Record<string, unknown>;
  error?: string;
}

interface ActionExecutionJob {
  executionId: string;
  tabId: string;
  eventsToken: string;
  dryRunSpeedMultiplier: DryRunSpeedMultiplier;
  mode: ExecutionMode;
  draft: CanonicalActionDraft;
  plan: CanonicalActionPlan;
  planDto: ActionPlanDto;
  status: CanonicalActionExecutionStatus;
  control: ActionExecutionControl;
  completedOperations: number;
  events: ActionExecutionEvent[];
  subscribers: Set<(event: ActionExecutionEvent) => void>;
  done: boolean;
}

interface TabAnalysisState {
  analysis?: ScanResult;
  skippedGroups: string[];
}

interface ApiRuntimeState {
  scan?: ScanSnapshot;
  accountName?: string;
  mutationScanId?: string;
  idleTimer?: NodeJS.Timeout;
}

interface TabAnalysisLookup {
  state?: TabAnalysisState;
}

interface CsvScanSource {
  fileName?: string;
  content?: string;
}

interface LiveScanSource {
  accountName?: string;
}

interface StaticFileLookup {
  path?: string;
}

interface AnalysisResultResponse extends ScanResult {
  skippedGroupIds: string[];
}

interface ItemSearchResponse {
  itemIds: string[];
}

interface CachedActionPlan {
  tabId: string;
  plan: CanonicalActionPlan;
}

export async function createApiServer(options: CreateApiServerOptions): Promise<FastifyInstance> {
  const { config, services } = options;
  const mode = sessionMode(config);
  const canShutdown = Boolean(options.lifecycle?.shutdown?.enabled);
  let enableMutations = config.enableMutations;
  const runtime: ApiRuntimeState = {};
  const scanJobs = new Map<string, ScanJob>();
  const actionExecutionJobs = new Map<string, ActionExecutionJob>();
  const actionPlans = new Map<string, CachedActionPlan>();
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

  function optionalTabAnalysisState(request: FastifyRequest): TabAnalysisLookup {
    return { state: tabStates.get(tabIdFor(request)) };
  }

  const server = Fastify({
    bodyLimit: 5_500_000,
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
    if (token === config.sessionToken || isAuthorizedEventStream(request.url, scanJobs, actionExecutionJobs)) {
      return;
    }

    await reply.code(401).send({ error: "本地会话令牌无效，请刷新页面后重试。" });
  });

  function sessionResponse() {
    return {
      token: config.sessionToken,
      mode,
      accountName: config.accountName,
      resumeAccountName: runtime.accountName,
      apiBaseUrl: `http://${config.host}:${config.port}`,
      enableMutations,
      hasServiceAccountToken: Boolean(config.serviceAccountToken),
      supportsDesktopAuth: true,
      idleShutdownMs: config.idleShutdownMs ?? 0,
      capabilities: sessionCapabilities(mode, canShutdown, Boolean(config.webDistDir), config.idleShutdownMs ?? 0)
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
    idleShutdownMs: config.idleShutdownMs ?? 0
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

    scheduleShutdown(ApiShutdownReason.Requested);
    return { ok: true };
  });

  server.get("/api/scan", async () => {
    if (!runtime.scan) {
      throw new ClientInputError("还没有扫描结果，请先运行一次扫描。");
    }
    return redactScanSnapshotForClient(runtime.scan);
  });

  server.post("/api/items/search", async (request): Promise<ItemSearchResponse> => {
    const body = itemSearchBodySchema.parse(request.body);
    const store = services.itemRepository.getStore();
    if (store.getState() === StoreState.Empty) {
      throw new ClientInputError("还没有扫描结果，请先运行一次扫描。");
    }
    const searchableItemIds = new Set(body.itemIds);
    return buildItemSearchResponse(store.listActive().filter((item) => searchableItemIds.has(item.id)), body.keywords);
  });

  server.get("/api/analysis", async (request) => {
    const lookup = optionalTabAnalysisState(request);
    if (!lookup.state?.analysis) {
      throw new ClientInputError("还没有分析结果，请先完成扫描并手动运行分析。");
    }
    return analysisResultResponse(lookup.state, currentAnalysisForGlobalScan(lookup.state.analysis, runtime));
  });

  server.post("/api/scan/clear", async (request, reply) => {
    if (runtime.mutationScanId) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前已有执行任务正在运行，请等待完成后再清空扫描结果。"
      });
    }

    resetGlobalScanState();

    return { ok: true };
  });

  server.post("/api/scan", async (request, reply) => {
    if (runtime.mutationScanId || hasActiveScanJob() || hasActiveActionExecution()) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前已有执行任务正在运行，请等待完成后再重新扫描。"
      });
    }

    const body = scanBodySchema.parse(request.body ?? {});
    const provider = body.provider ?? providerForScanMode(body.mode);
    const scanMode = scanModeForProvider(provider);
    const accountName = body.accountName || config.accountName;
    if (provider === ItemProvider.OnePassword && !config.serviceAccountToken && !accountName) {
      throw new ClientInputError("官方 1Password SDK 的 Desktop App 授权需要账户名或 account_uuid 来定位账户。它不是密码或 token；请在页面顶部填写，或用 OP_ACCOUNT_NAME 设置默认值。");
    }

    resetGlobalScanState();
    const scanId = createScanId();

    const job = createScanJob(scanId, scanMode);
    scanJobs.set(scanId, job);

    if (provider === ItemProvider.Mock) {
      void runMockScanJob(job);
      return { scanId, mode: scanMode, progress: job.progress, eventsToken: job.eventsToken };
    }

    if (provider === ItemProvider.Csv) {
      void runCsvScanJob(job, { fileName: body.fileName, content: body.csvContent });
      return { scanId, mode: scanMode, progress: job.progress, eventsToken: job.eventsToken };
    }

    void runLiveScanJob(job, { accountName });
    return { scanId, mode: scanMode, progress: job.progress, eventsToken: job.eventsToken };
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
      if (event.type === ScanProgressEventType.Completed || event.type === ScanProgressEventType.Failed) {
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
    currentScanSnapshotFor(body.scanId, runtime);
    const state = tabStateFor(request);
    state.analysis = services.workspaces.analyze(tabIdFor(request), services.itemRepository.getStore()).analysis;
    state.skippedGroups = [];
    return analysisResultResponse(state, state.analysis);
  });

  server.post("/api/items/:itemId/reveal", async (request): Promise<RevealCredentialsResponse> => {
    const params = itemParamsSchema.parse(request.params);
    const body = revealBodySchema.parse(request.body ?? {});
    const scan = currentScanSnapshotFor(body.scanId, runtime);
    if (!scan.items.some((item) => item.id === params.itemId)) {
      throw new ClientInputError(`找不到项目：${params.itemId}`);
    }

    const fields = canonicalRevealCredentials(params.itemId, services);

    return {
      scanId: scan.scanId,
      itemId: params.itemId,
      fields,
      expiresInSeconds: revealExpiresInSeconds
    };
  });

  server.post("/api/plan", async (request) => {
    const draft = actionDraftSchema.parse(request.body) as CanonicalActionDraft;
    const state = tabStateFor(request);
    const analysis = currentAnalysisFor(draft.storeSnapshotId, state);
    for (const group of draft.groups) {
      assertGroupIsNotSkipped(state, group.groupId);
    }
    const plan = await services.planning.createPlan(draft, analysis.groups);
    const tabId = tabIdFor(request);
    for (const [planId, cached] of actionPlans) {
      if (cached.tabId === tabId) actionPlans.delete(planId);
    }
    actionPlans.set(plan.planId, { tabId, plan });
    return toClientActionPlan(plan, services);
  });

  server.post("/api/groups/:groupId/skip", async (request, reply) => {
    if (runtime.mutationScanId) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前已有执行任务正在运行，请等待完成后再跳过重复组。"
      });
    }

    const params = groupParamsSchema.parse(request.params);
    const body = skipGroupBodySchema.parse(request.body ?? {});
    const state = tabStateFor(request);
    const scan = currentAnalysisForGlobalScan(currentAnalysisFor(body.scanId, state), runtime);
    const skippedGroup = scan.groups.find((group) => group.id === params.groupId);
    if (!skippedGroup) {
      throw new ClientInputError(`找不到重复组：${params.groupId}`);
    }

    if (!state.skippedGroups.includes(params.groupId)) {
      state.skippedGroups.push(params.groupId);
    }

    return {
      skippedGroupId: params.groupId,
      restorableSkippedGroupCount: state.skippedGroups.length,
      scan: analysisResultResponse(state, scan)
    };
  });

  server.post("/api/groups/:groupId/restore", async (request, reply) => {
    if (runtime.mutationScanId) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前已有执行任务正在运行，请等待完成后再取消跳过标记。"
      });
    }

    const params = groupParamsSchema.parse(request.params);
    const body = skipGroupBodySchema.parse(request.body ?? {});
    const state = tabStateFor(request);
    const scan = currentAnalysisForGlobalScan(currentAnalysisFor(body.scanId, state), runtime);
    if (!state.skippedGroups.includes(params.groupId)) {
      throw new ClientInputError(`该重复组未被标记跳过：${params.groupId}`);
    }

    state.skippedGroups = state.skippedGroups.filter((groupId) => groupId !== params.groupId);
    return {
      skippedGroupId: params.groupId,
      restorableSkippedGroupCount: state.skippedGroups.length,
      scan: analysisResultResponse(state, scan)
    };
  });

  server.post("/api/groups/restore-skipped", async (request, reply) => {
    if (runtime.mutationScanId) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前已有执行任务正在运行，请等待完成后再恢复跳过的重复组。"
      });
    }

    const body = restoreSkippedBodySchema.parse(request.body ?? {});
    const state = tabStateFor(request);
    const scan = currentAnalysisForGlobalScan(currentAnalysisFor(body.scanId, state), runtime);
    const restoredGroupId = state.skippedGroups.pop();
    if (!restoredGroupId) {
      throw new ClientInputError("没有可恢复的已跳过重复组。");
    }

    return {
      restoredGroupId,
      restorableSkippedGroupCount: state.skippedGroups.length,
      scan: analysisResultResponse(state, scan)
    };
  });

  server.post("/api/action-executions/start", async (request, reply) => {
    const body = actionExecutionStartSchema.parse(request.body);
    const state = tabStateFor(request);
    const cached = actionPlans.get(body.planId);
    if (!cached || cached.tabId !== tabIdFor(request) || cached.plan.planHash !== body.planHash) {
      throw new ClientInputError("ActionPlan 不存在、已失效或不属于当前 tab，请重新生成计划。");
    }
    const plan = cached.plan;
    currentAnalysisFor(plan.storeSnapshotId, state);
    for (const group of plan.groups) {
      assertGroupIsNotSkipped(state, group.groupId);
    }
    const store = services.itemRepository.getStore();
    if (store.getState() !== StoreState.Ready || store.getSnapshotId() !== plan.storeSnapshotId ||
      store.getVersion() !== plan.storeVersion) {
      actionPlans.delete(plan.planId);
      throw new ClientInputError("ActionPlan 对应的 Item Store 已发生变化，请重新生成计划。");
    }
    if (runtime.mutationScanId || hasActiveScanJob() || hasActiveActionExecution()) {
      return reply.code(409).send({ error: "冲突", message: "当前已有扫描或执行任务正在运行。" });
    }

    if (plan.blockers.length > 0) {
      return reply.code(422).send({ error: "计划不可执行", message: plan.blockers.join("\n"), plan: toClientActionPlan(plan, services) });
    }
    if (plan.requiresExplicitDeleteConfirmation && body.permanentDeleteConfirmationPhrase !== permanentDeleteConfirmationPhrase) {
      return reply.code(422).send({ error: "需要确认", message: `永久删除需要输入“${permanentDeleteConfirmationPhrase}”确认。` });
    }

    const mode = enableMutations ? ExecutionMode.Real : ExecutionMode.DryRun;
    if (mode === ExecutionMode.Real && !realExecutionSupported(plan, services)) {
      return reply.code(422).send({ error: "计划不可执行", message: "当前扫描源不支持真实写回。", plan: toClientActionPlan(plan, services) });
    }
    const draft = draftFromPlan(plan);
    const job = createActionExecutionJob(randomUUID(), tabIdFor(request), draft, plan, body.dryRunSpeedMultiplier, mode, services);
    actionExecutionJobs.set(job.executionId, job);
    actionPlans.delete(plan.planId);
    runtime.mutationScanId = plan.storeSnapshotId;
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
    if (job.status !== CanonicalActionExecutionStatus.Paused) {
      job.control.pause();
      job.status = CanonicalActionExecutionStatus.Paused;
      emitActionExecutionEvent(job, { type: ActionExecutionEventKind.Paused, message: "执行已暂停。" });
    }
    return actionExecutionSnapshot(job);
  });

  server.post("/api/action-executions/:executionId/resume", async (request, reply) => {
    const params = actionExecutionParamsSchema.parse(request.params);
    const job = actionExecutionFor(params.executionId);
    if (job.status !== CanonicalActionExecutionStatus.Paused) {
      return reply.code(409).send({ error: "无法继续", message: "只有已暂停的执行任务可以继续。" });
    }
    job.control.resume();
    job.status = CanonicalActionExecutionStatus.Running;
    emitActionExecutionEvent(job, { type: ActionExecutionEventKind.Resumed, message: "继续执行。" });
    return actionExecutionSnapshot(job);
  });

  server.post("/api/action-executions/:executionId/stop", async (request) => {
    const params = actionExecutionParamsSchema.parse(request.params);
    const job = actionExecutionFor(params.executionId);
    if (!terminalActionExecution(job.status) && !job.control.isStopRequested()) {
      job.control.stop();
      job.status = CanonicalActionExecutionStatus.StopRequested;
      emitActionExecutionEvent(job, { type: ActionExecutionEventKind.StopRequested, message: "正在停止执行。" });
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
      if (event.type === ActionExecutionEventKind.Stopped || event.type === ActionExecutionEventKind.Completed ||
        event.type === ActionExecutionEventKind.Failed) {
        reply.raw.end();
        cleanup();
      }
    };
    job.subscribers.add(subscriber);
    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
  });

  async function runActionExecution(job: ActionExecutionJob, state: TabAnalysisState): Promise<void> {
    try {
      const result = await services.execution.execute({
        executionId: job.executionId,
        plan: job.plan,
        mode: job.mode,
        dryRunSpeedMultiplier: job.dryRunSpeedMultiplier,
        control: job.control,
        onEvent: (event) => handleCanonicalExecutionEvent(job, event),
      });
      job.status = result.status;
      if (job.mode === ExecutionMode.Real) {
        services.workspaces.refreshAll(services.itemRepository.getStore());
        for (const [tabId, tabState] of tabStates) {
          const lookup = services.workspaces.tryGet(tabId);
          if (!lookup.found || !lookup.workspace) continue;
          tabState.analysis = lookup.workspace.analysis;
          tabState.skippedGroups = lookup.workspace.skippedGroupIds;
        }
        const workspace = services.workspaces.getRequired(job.tabId);
        runtime.scan = scanSnapshotFromAnalysis(workspace.analysis);
      }
      const responseAnalysis = job.mode === ExecutionMode.Real ? state.analysis! : result.analysis;
      const responseState: TabAnalysisState = {
        analysis: responseAnalysis,
        skippedGroups: state.skippedGroups.filter((groupId) => responseAnalysis.groups.some((group) => group.id === groupId)),
      };
      const response = {
        analysis: analysisResultResponse(responseState, responseAnalysis),
        storeVersion: result.storeVersion,
        itemIdMappings: result.itemIdMappings,
        dryRun: job.mode === ExecutionMode.DryRun,
      };
      emitActionExecutionEvent(job, { type: ActionExecutionEventKind.AnalysisUpdated, response });
      emitActionExecutionEvent(job, {
        type: terminalExecutionEventKind(job.status),
        response,
        error: result.succeeded || result.status === CanonicalActionExecutionStatus.Stopped ? undefined : "执行失败。",
      });
    } catch (error) {
      job.status = CanonicalActionExecutionStatus.Failed;
      emitActionExecutionEvent(job, { type: ActionExecutionEventKind.Failed, error: errorMessage(error) });
    } finally {
      job.done = true;
      runtime.mutationScanId = undefined;
    }
  }

  function handleCanonicalExecutionEvent(job: ActionExecutionJob, event: CanonicalExecutionEvent): void {
    if (event.kind === ActionExecutionEventKind.Completed || event.kind === ActionExecutionEventKind.Failed ||
      event.kind === ActionExecutionEventKind.Stopped) {
      return;
    }
    if (event.kind === ActionExecutionEventKind.StepCompleted) {
      job.completedOperations += 1;
    }
    const step = event.actionId
      ? job.planDto.groups.flatMap((group) => group.steps).find((candidate) => candidate.actionId === event.actionId)
      : undefined;
    emitActionExecutionEvent(job, {
      type: event.kind,
      actionId: event.actionId,
      groupId: step?.groupId,
      stepStatus: event.status,
      message: event.message,
      error: event.kind === ActionExecutionEventKind.StepFailed ? event.message : undefined,
    });
  }

  function hasActiveActionExecution(): boolean {
    return Array.from(actionExecutionJobs.values()).some((job) => !job.done);
  }

  function actionExecutionFor(executionId: string): ActionExecutionJob {
    const job = actionExecutionJobs.get(executionId);
    if (!job) {
      throw new ClientInputError("找不到执行任务，请重新开始应用计划。");
    }
    return job;
  }

  async function runMockScanJob(job: ScanJob): Promise<void> {
    try {
      const storeSnapshot = await services.synchronization.synchronize(ItemProvider.Mock, "mock", undefined, undefined,
        (message, scannedItems) => {
          if (job.cancelled) return;
          job.progress = { ...job.progress, scannedItems, totalItems: Math.max(job.progress.totalItems, scannedItems), message };
          emitScanEvent(job, { type: ScanProgressEventType.Progress, progress: job.progress });
        });
      if (job.cancelled) return;
      const canonicalAnalysis = services.analysis.analyze(services.itemRepository.getStore());
      const snapshot = scanSnapshotFromAnalysis(canonicalAnalysis);
      snapshot.scannedAt = storeSnapshot.createdAt;
      runtime.scan = snapshot;
      runtime.accountName = undefined;
      job.progress = progressFor(job.scanId, ScanPhase.Completed, snapshot.vaults, snapshot.items, snapshot.items.length,
        snapshot.vaults.length, "扫描完成，等待手动分析。");
      emitScanEvent(job, { type: ScanProgressEventType.Completed, progress: job.progress, scan: redactScanSnapshotForClient(snapshot) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.progress = { ...job.progress, phase: ScanPhase.Failed, message, error: message };
      emitScanEvent(job, { type: ScanProgressEventType.Failed, progress: job.progress, error: message });
    }
  }

  async function runCsvScanJob(job: ScanJob, source: CsvScanSource): Promise<void> {
    try {
      const { fileName, content: csvContent } = source;
      if (!fileName || !csvContent) {
        throw new ClientInputError("请选择一份 1Password 导出的 CSV 文件。");
      }
      const snapshot = await services.synchronization.synchronize(
        ItemProvider.Csv,
        fileName,
        undefined,
        undefined,
        (message, scannedItems) => {
          if (job.cancelled) {
            return;
          }
          job.progress = {
            ...job.progress,
            scannedItems,
            totalItems: Math.max(job.progress.totalItems, scannedItems),
            message,
          };
          emitScanEvent(job, { type: ScanProgressEventType.Progress, progress: job.progress });
        },
        fileName,
        csvContent,
      );
      if (job.cancelled) {
        return;
      }
      const analysis = services.analysis.analyze(services.itemRepository.getStore());
      const normalizedScan: ScanSnapshot = {
        scanId: analysis.scanId,
        scannedAt: snapshot.createdAt,
        vaults: analysis.vaults,
        items: analysis.items,
      };
      runtime.scan = normalizedScan;
      runtime.accountName = undefined;
      job.progress = progressFor(job.scanId, ScanPhase.Completed, normalizedScan.vaults, normalizedScan.items,
        normalizedScan.items.length, normalizedScan.vaults.length, "CSV 扫描完成，等待手动分析。");
      emitScanEvent(job, { type: ScanProgressEventType.Completed, progress: job.progress, scan: redactScanSnapshotForClient(normalizedScan) });
    } catch (error) {
      if (job.cancelled) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      job.progress = { ...job.progress, phase: ScanPhase.Failed, message, error: message };
      emitScanEvent(job, { type: ScanProgressEventType.Failed, progress: job.progress, error: message });
    }
  }

  async function runLiveScanJob(job: ScanJob, source: LiveScanSource): Promise<void> {
    try {
      const { accountName } = source;
      const snapshot = await services.synchronization.synchronize(
        ItemProvider.OnePassword,
        accountName || "default",
        accountName,
        config.serviceAccountToken,
        (message, scannedItems, sourceProgress) => {
          if (job.cancelled) return;
          job.progress = sourceProgress
            ? { ...sourceProgress, scanId: job.scanId, message }
            : { ...job.progress, scannedItems, totalItems: Math.max(job.progress.totalItems, scannedItems), message };
          emitScanEvent(job, { type: ScanProgressEventType.Progress, progress: job.progress });
        }
      );
      if (job.cancelled) return;
      const canonicalAnalysis = services.analysis.analyze(services.itemRepository.getStore());
      const normalizedScan = scanSnapshotFromAnalysis(canonicalAnalysis);
      normalizedScan.scannedAt = snapshot.createdAt;
      runtime.scan = normalizedScan;
      runtime.accountName = config.serviceAccountToken ? undefined : accountName;
      job.progress = progressFor(job.scanId, ScanPhase.Completed, normalizedScan.vaults, normalizedScan.items,
        normalizedScan.items.length, normalizedScan.vaults.length, "扫描完成，等待手动分析。");
      emitScanEvent(job, { type: ScanProgressEventType.Completed, progress: job.progress, scan: redactScanSnapshotForClient(normalizedScan) });
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
        phase: ScanPhase.Failed,
        message,
        error: message
      };
      emitScanEvent(job, {
        type: ScanProgressEventType.Failed,
        progress: job.progress,
        error: message
      });
    }
  }

  await registerStaticUi(server, config.webDistDir ?? "");
  server.addHook("onClose", async () => {
    services.synchronization.clear();
    services.workspaces.clear();
  });
  refreshIdleTimer();

  return server;

  function hasActiveWork(): boolean {
    return Boolean(runtime.mutationScanId) || hasActiveScanJob() || hasActiveActionExecution();
  }

  function resetGlobalScanState(): void {
    runtime.scan = undefined;
    runtime.accountName = undefined;
    tabStates.clear();
    cancelScanJobs(scanJobs);
    scanJobs.clear();
    actionPlans.clear();
    actionExecutionJobs.clear();
    services.synchronization.clear();
    services.workspaces.clear();
  }

  function hasActiveScanJob(): boolean {
    return Array.from(scanJobs.values()).some((job) => !job.done);
  }

  function refreshIdleTimer(): void {
    if (!config.idleShutdownMs || !canShutdown) {
      return;
    }

    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
    }
    runtime.idleTimer = setTimeout(() => {
      if (hasActiveWork()) {
        refreshIdleTimer();
        return;
      }
      scheduleShutdown(ApiShutdownReason.Idle);
    }, config.idleShutdownMs);
    runtime.idleTimer.unref();
  }

  function scheduleShutdown(reason: ApiShutdownReason): void {
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = undefined;
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
  return config.mode ?? AppMode.BrowserDev;
}

function sessionCapabilities(
  mode: AppMode,
  canShutdown: boolean,
  hasStaticUi: boolean,
  idleShutdownMs: number
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
  mode: z.nativeEnum(ScanMode).default(ScanMode.Live),
  provider: z.enum([ItemProvider.OnePassword, ItemProvider.Csv, ItemProvider.Mock]).optional(),
  fileName: z.string().trim().min(1).max(255).optional(),
  csvContent: z.string().max(5_000_000).optional()
});

function providerForScanMode(mode: ScanMode): ItemProvider {
  if (mode === ScanMode.Csv) return ItemProvider.Csv;
  if (mode === ScanMode.Mock) return ItemProvider.Mock;
  return ItemProvider.OnePassword;
}

function scanModeForProvider(provider: ItemProvider): ScanMode {
  if (provider === ItemProvider.Csv) return ScanMode.Csv;
  if (provider === ItemProvider.Mock) return ScanMode.Mock;
  return ScanMode.Live;
}

const scanEventsQuerySchema = z.object({
  scanId: z.string().min(1),
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
  keywords: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  itemIds: z.array(z.string().min(1)).max(20_000),
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
  state.skippedGroups = [];
}

const actionDraftItemSchema = z.object({
  itemId: z.string().min(1),
  disposition: z.nativeEnum(ItemDisposition),
  desiredTitle: z.string().trim().min(1).optional(),
  targetContainerId: z.string().optional(),
  removeTags: z.array(z.string().min(1)).default([])
});

const actionDraftSchema = z.object({
  storeSnapshotId: z.string().min(1),
  storeVersion: z.number().int().min(1),
  groups: z.array(z.object({
    groupId: z.string().min(1),
    items: z.array(actionDraftItemSchema).min(2)
  })).min(1)
});

const actionExecutionStartSchema = z.object({
  planId: z.string().min(1),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  permanentDeleteConfirmationPhrase: z.string().optional(),
  dryRunSpeedMultiplier: z.nativeEnum(DryRunSpeedMultiplier).default(DryRunSpeedMultiplier.One)
});

function draftFromPlan(plan: CanonicalActionPlan): CanonicalActionDraft {
  return {
    storeSnapshotId: plan.storeSnapshotId,
    storeVersion: plan.storeVersion,
    groups: plan.groups.map((group) => ({
      groupId: group.groupId,
      items: group.items.map((item) => ({ ...item.intent, removeTags: [...item.intent.removeTags] })),
    })),
  };
}

function createScanId(): string {
  return randomUUID();
}

function createScanJob(scanId: string, mode: ScanMode): ScanJob {
  const startedAt = new Date().toISOString();
  const progress: ScanProgress = {
    scanId,
    phase: ScanPhase.Scanning,
    startedAt,
    totalVaults: 0,
    scannedVaults: 0,
    totalItems: 0,
    scannedItems: 0,
    vaults: [],
    message: mode === ScanMode.Mock ? "正在准备演示数据。" : mode === ScanMode.Csv ? "正在读取 CSV 文件。" : "正在等待 1Password 授权。"
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
  emitScanEvent(job, { type: ScanProgressEventType.Started, progress });
  return job;
}

function createActionExecutionJob(
  executionId: string,
  tabId: string,
  draft: CanonicalActionDraft,
  plan: CanonicalActionPlan,
  dryRunSpeedMultiplier: DryRunSpeedMultiplier,
  mode: ExecutionMode,
  services: import("./item-services.js").ApplicationServices
): ActionExecutionJob {
  return {
    executionId,
    tabId,
    eventsToken: randomUUID(),
    dryRunSpeedMultiplier,
    mode,
    draft,
    plan,
    planDto: toClientActionPlan(plan, services),
    status: CanonicalActionExecutionStatus.Running,
    control: new ActionExecutionControl(),
    completedOperations: 0,
    events: [],
    subscribers: new Set(),
    done: false
  };
}

function actionExecutionSnapshot(job: ActionExecutionJob, includeCredentials = false): Record<string, unknown> {
  return {
    executionId: job.executionId,
    eventsToken: includeCredentials ? job.eventsToken : undefined,
    status: job.status,
    writeEnabled: job.mode === ExecutionMode.Real,
    dryRunSpeedMultiplier: job.dryRunSpeedMultiplier,
    totalGroups: job.planDto.statistics.groupCount,
    totalOperations: job.planDto.statistics.mutationStepCount,
    completedOperations: job.completedOperations,
    cancelledOperations: 0,
    plan: job.planDto,
    draft: job.draft
  };
}

function emitActionExecutionEvent(job: ActionExecutionJob, event: Partial<ActionExecutionEvent> & { type: ActionExecutionEventKind }): void {
  const sequenced: ActionExecutionEvent = {
    executionId: job.executionId,
    status: job.status,
    writeEnabled: job.mode === ExecutionMode.Real,
    totalGroups: job.planDto.statistics.groupCount,
    totalOperations: job.planDto.statistics.mutationStepCount,
    completedOperations: job.completedOperations,
    sequence: job.events.length + 1,
    ...event
  };
  job.events.push(sequenced);
  for (const subscriber of job.subscribers) {
    subscriber(sequenced);
  }
}

function terminalActionExecution(status: CanonicalActionExecutionStatus): boolean {
  return status === CanonicalActionExecutionStatus.Stopped || status === CanonicalActionExecutionStatus.Completed ||
    status === CanonicalActionExecutionStatus.Failed;
}

function terminalExecutionEventKind(status: CanonicalActionExecutionStatus): ActionExecutionEventKind {
  if (status === CanonicalActionExecutionStatus.Completed) return ActionExecutionEventKind.Completed;
  if (status === CanonicalActionExecutionStatus.Stopped) return ActionExecutionEventKind.Stopped;
  return ActionExecutionEventKind.Failed;
}

function cancelScanJobs(scanJobs: Map<string, ScanJob>): void {
  for (const job of scanJobs.values()) {
    if (job.done || job.cancelled) {
      continue;
    }

    job.cancelled = true;
    emitScanEvent(job, {
      type: ScanProgressEventType.Failed,
      error: "扫描已取消。",
      progress: {
        ...job.progress,
        phase: ScanPhase.Failed,
        message: "扫描已取消。",
        error: "扫描已取消。"
      }
    });
  }
}

function emitScanEvent(job: ScanJob, event: ScanProgressEvent): void {
  const terminal = event.type === ScanProgressEventType.Completed || event.type === ScanProgressEventType.Failed;
  const normalizedEvent: ScanProgressEvent = {
    ...event,
    progress: {
      ...event.progress,
      startedAt: event.progress.startedAt ?? job.progress.startedAt ?? job.events[0]?.progress.startedAt,
      finishedAt: terminal ? event.progress.finishedAt ?? new Date().toISOString() : event.progress.finishedAt
    }
  };
  job.progress = normalizedEvent.progress;
  job.events.push(normalizedEvent);
  for (const subscriber of job.subscribers) {
    subscriber(normalizedEvent);
  }
  if (terminal) {
    job.done = true;
  }
}

function isAuthorizedEventStream(
  url: string,
  scanJobs: Map<string, ScanJob>,
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
  const actionExecutionMatch = parsed.pathname.match(/^\/api\/action-executions\/([^/]+)\/events$/);
  if (actionExecutionMatch) {
    return actionExecutionJobs.get(decodeURIComponent(actionExecutionMatch[1]))?.eventsToken === eventsToken;
  }
  return false;
}

function corsHeadersFor(origin: unknown, allowedOrigins: string[]): Record<string, string> {
  if (typeof origin !== "string" || !origin) {
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

function toSseMessage(event: { type: string; sequence?: number }): string {
  const id = event.sequence ? `id: ${event.sequence}\n` : "";
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function lastEventSequence(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") {
    return 0;
  }
  const sequence = Number.parseInt(raw ?? "0", 10);
  return Number.isFinite(sequence) && sequence > 0 ? sequence : 0;
}

function canonicalRevealCredentials(
  itemId: string,
  services: import("./item-services.js").ApplicationServices
): RevealedCredentialField[] {
  const item = services.itemRepository.getStore().getRequired(itemId);
  return item.fields
    .filter((field) => field.value !== undefined)
    .map((field) => ({ label: field.label, value: field.value!, fieldType: field.kind }));
}

function currentScanSnapshotFor(scanId: string, runtime: ApiRuntimeState): ScanSnapshot {
  if (!runtime.scan) {
    throw new ClientInputError("请先运行扫描。");
  }

  if (scanId !== runtime.scan.scanId) {
    throw new ClientInputError("当前扫描结果已过期，请重新扫描后再继续。");
  }

  return runtime.scan;
}

function currentAnalysisFor(scanId: string, state: TabAnalysisState): ScanResult {
  if (!state.analysis) {
    throw new ClientInputError("请先完成扫描并手动运行分析。");
  }

  if (scanId !== state.analysis.scanId) {
    throw new ClientInputError("当前分析结果已过期，请重新扫描并重新分析后再继续。");
  }

  return state.analysis;
}

function currentAnalysisForGlobalScan(analysis: ScanResult, runtime: ApiRuntimeState): ScanResult {
  if (!runtime.scan) {
    throw new ClientInputError("当前扫描结果已过期，请重新扫描并重新分析后再继续。");
  }

  if (analysis.scanId !== runtime.scan.scanId) {
    throw new ClientInputError("当前分析结果已过期，请基于最新扫描重新分析后再继续。");
  }

  return analysis;
}

class ClientInputError extends Error {
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

function buildItemSearchResponse(items: CanonicalItem[], keywords: string[]): ItemSearchResponse {
  const normalizedKeywords = Array.from(new Set(keywords.map(normalizeLooseText).filter(Boolean)));
  return {
    itemIds: items
      .filter((item) => normalizedKeywords.every((keyword) => itemMatchesSearchKeyword(item, keyword)))
      .map((item) => item.id),
  };
}

function itemMatchesSearchKeyword(item: CanonicalItem, keyword: string): boolean {
  return searchValuesForItem(item).some((value) => normalizeLooseText(value).includes(keyword));
}

function searchValuesForItem(item: CanonicalItem): string[] {
  return [
    item.title,
    ...item.identities.map((identity) => identity.value),
    ...item.urls.map((url) => url.value),
  ];
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
    storeVersion: scan.storeVersion,
    analyzedAt: scan.analyzedAt,
    groups: scan.groups
  };
}

function scanSnapshotFromAnalysis(analysis: ScanResult): ScanSnapshot {
  return {
    scanId: analysis.scanId,
    scannedAt: analysis.scannedAt,
    durationMs: analysis.durationMs,
    vaults: analysis.vaults,
    items: analysis.items,
  };
}

function toClientActionPlan(
  plan: CanonicalActionPlan,
  services: import("./item-services.js").ApplicationServices
): ActionPlanDto {
  return toActionPlanDto(plan, realExecutionSupported(plan, services));
}

function realExecutionSupported(
  plan: CanonicalActionPlan,
  services: import("./item-services.js").ApplicationServices
): boolean {
  return plan.groups.every((group) => group.items.every((item) => item.actions.every((action) => {
    const capabilities = services.backendRegistry.get(action.provider).getCapabilities();
    if (action.kind === ActionKind.Keep) return true;
    if (action.kind === ActionKind.Create) return capabilities.supportsCreate;
    if (action.kind === ActionKind.Update) return capabilities.supportsUpdate;
    if (action.kind === ActionKind.Archive) return capabilities.supportsArchive;
    return capabilities.supportsDelete;
  })));
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

async function registerStaticUi(server: FastifyInstance, webDistDir: string): Promise<void> {
  if (!webDistDir || !(await directoryExists(webDistDir))) {
    return;
  }

  const root = resolve(webDistDir);
  server.get("/*", async (request, reply) => {
    const rawPath = request.url.split("?")[0] || "/";
    const decodedPath = safeDecodePath(rawPath);
    const candidatePath = decodedPath === "/" ? "/index.html" : decodedPath;
    const file = await resolveStaticFile(root, candidatePath);

    if (!file.path) {
      return reply.code(404).send({ error: "找不到请求的资源。" });
    }

    reply.type(contentTypeFor(file.path));
    return reply.send(createReadStream(file.path));
  });
}

async function resolveStaticFile(root: string, requestPath: string): Promise<StaticFileLookup> {
  const relativePath = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^[/\\]+/, "");
  const requestedFile = resolve(root, relativePath);
  if (!isInside(root, requestedFile)) {
    return {};
  }

  if (await fileExists(requestedFile)) {
    return { path: requestedFile };
  }

  const indexFile = join(root, "index.html");
  if (!extname(requestPath) && await fileExists(indexFile)) {
    return { path: indexFile };
  }

  return {};
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
