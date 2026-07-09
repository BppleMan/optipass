import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";
import cors from "@fastify/cors";
import Fastify, { FastifyInstance, FastifyRequest } from "fastify";
import {
  createExecutionPlan,
  findDuplicateGroups,
  GroupDecision,
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
  copyToVaultAndArchiveSource(appItemId: string, targetVaultId: string): Promise<CopyToVaultResult>;
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

interface TabAnalysisState {
  analysis?: ScanResult;
  dryRunKey?: string;
  skippedGroups: ScanResult["groups"];
}

export async function createApiServer(options: CreateApiServerOptions): Promise<FastifyInstance> {
  const { config, onePassword } = options;
  const mode = sessionMode(config);
  const canShutdown = Boolean(options.lifecycle?.shutdown?.enabled);
  let enableMutations = config.enableMutations;
  let latestScan: ScanSnapshot | undefined;
  let latestScanMode: ScanMode | undefined;
  let activeMutationScanId: string | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const scanJobs = new Map<string, ScanJob>();
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
    if (token === config.sessionToken || isAuthorizedScanEventStream(request.url, scanJobs)) {
      return;
    }

    await reply.code(401).send({ error: "本地会话令牌无效，请刷新页面后重试。" });
  });

  function sessionResponse() {
    return {
      token: config.sessionToken,
      mode,
      accountName: config.accountName,
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

  server.get("/api/analysis", async (request) => {
    const state = optionalTabAnalysisState(request);
    if (!state?.analysis) {
      throw new ClientInputError("还没有分析结果，请先完成扫描并手动运行分析。");
    }
    return redactScanResultForClient(currentAnalysisForGlobalScan(state.analysis, latestScan));
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
    return redactScanResultForClient(state.analysis);
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

    state.skippedGroups.push(skippedGroup);
    state.analysis = removeCompletedGroup(scan, params.groupId);
    state.dryRunKey = undefined;

    return {
      skippedGroupId: params.groupId,
      restorableSkippedGroupCount: state.skippedGroups.length,
      scan: redactScanResultForClient(state.analysis)
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
    const restoredGroup = state.skippedGroups.pop();
    if (!restoredGroup) {
      throw new ClientInputError("没有可恢复的已跳过重复组。");
    }

    state.analysis = {
      ...scan,
      groups: [restoredGroup, ...scan.groups]
    };
    state.dryRunKey = undefined;

    return {
      restoredGroupId: restoredGroup.id,
      restorableSkippedGroupCount: state.skippedGroups.length,
      scan: redactScanResultForClient(state.analysis)
    };
  });

  server.post("/api/execute", async (request) => {
    const decision = decisionSchema.parse(request.body) satisfies DecisionBody;
    const state = tabStateFor(request);
    currentAnalysisForGlobalScan(currentAnalysisFor(decision.scanId, state.analysis), latestScan);
    const plan = createPlanFromLatestScan(decision, state.analysis);

    if (plan.blockers.length > 0) {
      return { plan, results: [], blocked: true };
    }
    if (decision.dryRun || latestScanMode === "mock") {
      const shouldAdvanceMockScan = !decision.dryRun && latestScanMode === "mock";
      if (shouldAdvanceMockScan) {
        state.analysis = removeCompletedGroup(state.analysis!, decision.groupId);
        state.dryRunKey = undefined;
        state.skippedGroups = [];
      } else if (decision.dryRun) {
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
        dryRunKey: decision.dryRun ? state.dryRunKey : undefined,
        completedGroupId: shouldAdvanceMockScan ? decision.groupId : undefined,
        scan: shouldAdvanceMockScan && state.analysis ? redactScanResultForClient(state.analysis) : undefined
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

    if (!enableMutations) {
      return {
        plan,
        results: [],
        blocked: true,
        error: mutationDisabledMessage()
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
        resetTabAnalysisState(state);
        return { plan, results, scanInvalidated: true };
      }

      const verification = await verifyExecutedPlan(plan.actions, state.analysis!, results, beforeStates, involvedVaultIds, onePassword);
      if (!verification.ok) {
        latestScan = undefined;
        latestScanMode = undefined;
        resetTabAnalysisState(state);
        return { plan, results, verification, scanInvalidated: true };
      }

      state.analysis = removeCompletedGroup(state.analysis!, decision.groupId);
      state.dryRunKey = undefined;
      state.skippedGroups = [];
      return {
        plan,
        results,
        verification,
        completedGroupId: decision.groupId,
        scan: redactScanResultForClient(state.analysis),
        scanInvalidated: false,
        mutated: hasMutation
      };
    } finally {
      activeMutationScanId = undefined;
    }
  });

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
    return Boolean(activeMutationScanId) || hasActiveScanJob();
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

const analyzeBodySchema = z.object({
  scanId: z.string().min(1)
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
      deleteMode: z.enum(["archive", "delete"]).optional()
    })
  )
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

function isAuthorizedScanEventStream(url: string, scanJobs: Map<string, ScanJob>): boolean {
  const parsed = new URL(url, "http://127.0.0.1");
  if (parsed.pathname !== "/api/scan/events") {
    return false;
  }

  const scanId = parsed.searchParams.get("scanId");
  const eventsToken = parsed.searchParams.get("eventsToken");
  if (!scanId || !eventsToken) {
    return false;
  }

  return scanJobs.get(scanId)?.eventsToken === eventsToken;
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

function toSseMessage(event: ScanProgressEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
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

function validateTargetVaults(decision: GroupDecision, scan: ScanResult): string[] {
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

function mutationDisabledMessage(): string {
  return "真实 1Password 变更当前已在状态栏关闭。请先在状态栏切换为可写，再执行真实归档、删除或迁移。";
}

async function executePlanActions(actions: PlanAction[], latestScan: ScanResult, onePassword: PasswordService): Promise<ExecuteActionResult[]> {
  const itemById = new Map(latestScan.items.map((item) => [item.id, item]));
  const results: ExecuteActionResult[] = [];

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (action.type === "keep") {
      results.push({ itemId: action.itemId, action: action.type, ok: true });
      continue;
    }

    const item = itemById.get(action.itemId);
    if (!item) {
      results.push({ itemId: action.itemId, action: action.type, ok: false, error: "找不到要处理的项目。" });
      results.push(...skippedResults(actions.slice(index + 1)));
      break;
    }

    try {
      if (action.type === "archive") {
        await onePassword.archive(item.vaultId, item.onePasswordItemId);
      } else if (action.type === "delete") {
        await onePassword.delete(item.vaultId, item.onePasswordItemId);
      } else if (action.type === "copy-to-vault-and-archive-source") {
        const copyResult = await onePassword.copyToVaultAndArchiveSource(item.id, action.targetVaultId);
        results.push({
          itemId: action.itemId,
          action: action.type,
          ok: true,
          createdItemId: copyResult.createdItemId,
          targetVaultId: action.targetVaultId
        });
        continue;
      }
      results.push({ itemId: action.itemId, action: action.type, ok: true });
    } catch (error) {
      results.push({
        itemId: action.itemId,
        action: action.type,
        ok: false,
        error: mutationActionError(action, error)
      });
      results.push(...skippedResults(actions.slice(index + 1)));
      break;
    }
  }

  return results;
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

function redactScanSnapshotForClient(scan: ScanSnapshot): ScanSnapshot {
  return {
    ...scan,
    items: scan.items.map((item) => ({
      ...item,
      comparableFields: [],
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
