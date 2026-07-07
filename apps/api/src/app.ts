import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";
import cors from "@fastify/cors";
import Fastify, { FastifyInstance } from "fastify";
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
  copyToVaultAndArchiveSource(appItemId: string, targetVaultId: string): Promise<void>;
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

export async function createApiServer(options: CreateApiServerOptions): Promise<FastifyInstance> {
  const { config, onePassword } = options;
  const mode = sessionMode(config);
  const canShutdown = Boolean(options.lifecycle?.shutdown?.enabled);
  let latestScan: ScanSnapshot | undefined;
  let latestAnalysis: ScanResult | undefined;
  let latestScanMode: ScanMode | undefined;
  let activeMutationScanId: string | undefined;
  let latestDryRunKey: string | undefined;
  let latestSkippedGroups: ScanResult["groups"] = [];
  let idleTimer: NodeJS.Timeout | undefined;
  const scanJobs = new Map<string, ScanJob>();

  const server = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL || "info"
    }
  });

  await server.register(cors, {
    origin: config.webOrigins,
    credentials: false,
    allowedHeaders: ["content-type", "x-session-token"]
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

  server.get("/healthz", async () => ({ ok: true }));

  server.get("/api/session", async () => ({
    token: config.sessionToken,
    mode,
    accountName: config.accountName,
    apiBaseUrl: `http://${config.host}:${config.port}`,
    enableMutations: config.enableMutations,
    forceDryRun: config.forceDryRun,
    hasServiceAccountToken: Boolean(config.serviceAccountToken),
    supportsDesktopAuth: true,
    idleShutdownMs: config.idleShutdownMs ?? null,
    capabilities: sessionCapabilities(mode, canShutdown, Boolean(config.webDistDir), config.idleShutdownMs)
  }));

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

  server.get("/api/analysis", async () => {
    if (!latestAnalysis) {
      throw new ClientInputError("还没有分析结果，请先完成扫描并手动运行分析。");
    }
    return redactScanResultForClient(latestAnalysis);
  });

  server.post("/api/scan/clear", async (_request, reply) => {
    if (activeMutationScanId) {
      return reply.code(409).send({
        error: "冲突",
        message: "当前已有执行任务正在运行，请等待完成后再清空扫描结果。"
      });
    }

    latestScan = undefined;
    latestAnalysis = undefined;
    latestScanMode = undefined;
    latestDryRunKey = undefined;
    latestSkippedGroups = [];
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
    latestScan = undefined;
    latestAnalysis = undefined;
    latestScanMode = body.mode;
    latestDryRunKey = undefined;
    latestSkippedGroups = [];

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

  server.get("/api/scan/events", async (request, reply) => {
    const query = scanEventsQuerySchema.parse(request.query ?? {});
    const job = scanJobs.get(query.scanId);
    if (!job) {
      throw new ClientInputError("找不到扫描任务，请重新开始扫描。");
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

    for (const event of job.events) {
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
    latestAnalysis = analyzeScan(scan);
    latestDryRunKey = undefined;
    latestSkippedGroups = [];
    return redactScanResultForClient(latestAnalysis);
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
    const plan = createPlanFromLatestScan(decision, latestAnalysis);
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
    const scan = currentAnalysisFor(body.scanId, latestAnalysis);
    const skippedGroup = scan.groups.find((group) => group.id === params.groupId);
    if (!skippedGroup) {
      throw new ClientInputError(`找不到重复组：${params.groupId}`);
    }

    latestSkippedGroups.push(skippedGroup);
    latestAnalysis = removeCompletedGroup(scan, params.groupId);
    latestDryRunKey = undefined;

    return {
      skippedGroupId: params.groupId,
      restorableSkippedGroupCount: latestSkippedGroups.length,
      scan: redactScanResultForClient(latestAnalysis)
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
    const scan = currentAnalysisFor(body.scanId, latestAnalysis);
    const restoredGroup = latestSkippedGroups.pop();
    if (!restoredGroup) {
      throw new ClientInputError("没有可恢复的已跳过重复组。");
    }

    latestAnalysis = {
      ...scan,
      groups: [restoredGroup, ...scan.groups]
    };
    latestDryRunKey = undefined;

    return {
      restoredGroupId: restoredGroup.id,
      restorableSkippedGroupCount: latestSkippedGroups.length,
      scan: redactScanResultForClient(latestAnalysis)
    };
  });

  server.post("/api/execute", async (request) => {
    const decision = decisionSchema.parse(request.body) satisfies DecisionBody;
    const plan = createPlanFromLatestScan(decision, latestAnalysis);

    if (plan.blockers.length > 0) {
      return { plan, results: [], blocked: true };
    }
    if (decision.dryRun || latestScanMode === "mock") {
      const shouldAdvanceMockScan = !decision.dryRun && latestScanMode === "mock";
      if (shouldAdvanceMockScan) {
        latestAnalysis = removeCompletedGroup(latestAnalysis!, decision.groupId);
        latestDryRunKey = undefined;
        latestSkippedGroups = [];
      } else if (decision.dryRun) {
        latestDryRunKey = dryRunKeyFor(decision, plan.actions);
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
        dryRunKey: decision.dryRun ? latestDryRunKey : undefined,
        completedGroupId: shouldAdvanceMockScan ? decision.groupId : undefined,
        scan: shouldAdvanceMockScan && latestAnalysis ? redactScanResultForClient(latestAnalysis) : undefined
      };
    }

    const requiredDryRunKey = dryRunKeyFor(decision, plan.actions);
    if (decision.confirmedDryRunKey !== requiredDryRunKey || latestDryRunKey !== requiredDryRunKey) {
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

    if (!config.enableMutations) {
      return {
        plan,
        results: [],
        blocked: true,
        error: mutationDisabledMessage(config)
      };
    }

    activeMutationScanId = decision.scanId;
    try {
      const results = await executePlanActions(plan.actions, latestAnalysis!, onePassword);
      const hasFailure = results.some((result) => !result.ok);
      const hasMutation = results.some((result) => result.ok && result.action !== "keep");
      if (hasFailure) {
        latestScan = undefined;
        latestAnalysis = undefined;
        latestScanMode = undefined;
        latestDryRunKey = undefined;
        latestSkippedGroups = [];
        return { plan, results, scanInvalidated: true };
      }

      latestAnalysis = removeCompletedGroup(latestAnalysis!, decision.groupId);
      latestDryRunKey = undefined;
      latestSkippedGroups = [];
      return {
        plan,
        results,
        completedGroupId: decision.groupId,
        scan: redactScanResultForClient(latestAnalysis),
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
  scanId: z.string().min(1)
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

function mutationDisabledMessage(config: ApiConfig): string {
  if (config.forceDryRun) {
    return "真实 1Password 变更已被开发保护禁用。只有取消 OP_FORCE_DRY_RUN 并显式设置 OP_ENABLE_MUTATIONS=true 后，才能执行真实归档、删除或迁移。";
  }
  return "真实 1Password 变更当前已禁用。只有显式设置 OP_ENABLE_MUTATIONS=true 后，才能执行真实归档、删除或迁移。";
}

async function executePlanActions(actions: PlanAction[], latestScan: ScanResult, onePassword: PasswordService) {
  const itemById = new Map(latestScan.items.map((item) => [item.id, item]));
  const results: Array<{ itemId: string; action: string; ok: boolean; error?: string; skipped?: boolean }> = [];

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
        await onePassword.copyToVaultAndArchiveSource(item.id, action.targetVaultId);
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

function skippedResults(actions: PlanAction[]): Array<{ itemId: string; action: string; ok: boolean; skipped: boolean; error: string }> {
  return actions.map((action) => ({
    itemId: action.itemId,
    action: action.type,
    ok: false,
    skipped: true,
    error: "由于前一个操作失败，已跳过。"
  }));
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
      comparableFields: []
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
