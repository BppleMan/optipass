import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";
import cors from "@fastify/cors";
import Fastify, { FastifyInstance } from "fastify";
import {
  createExecutionPlan,
  GroupDecision,
  PlanAction,
  ScanResult,
  validateDecisionItemSet
} from "@optimize-password/core";
import { z, ZodError } from "zod";
import { ApiConfig } from "./config.js";
import { createMockScanResult } from "./mock-data.js";

export interface PasswordService {
  scan(options: { serviceAccountToken?: string; accountName?: string }): Promise<ScanResult>;
  archive(vaultId: string, onePasswordItemId: string): Promise<void>;
  delete(vaultId: string, onePasswordItemId: string): Promise<void>;
  copyToVaultAndArchiveSource(appItemId: string, targetVaultId: string): Promise<void>;
  clearCache(): void;
}

export interface CreateApiServerOptions {
  config: ApiConfig;
  onePassword: PasswordService;
  logger?: boolean | { level: string };
}

type ScanMode = "live" | "mock";
const permanentDeleteConfirmationPhrase = "永久删除";
type DecisionBody = GroupDecision & {
  confirmPermanentDelete?: boolean;
  permanentDeleteConfirmationPhrase?: string;
  confirmedDryRunKey?: string;
  dryRun?: boolean;
};

export async function createApiServer(options: CreateApiServerOptions): Promise<FastifyInstance> {
  const { config, onePassword } = options;
  let latestScan: ScanResult | undefined;
  let latestScanMode: ScanMode | undefined;
  let activeMutationScanId: string | undefined;
  let latestDryRunKey: string | undefined;
  let latestSkippedGroups: ScanResult["groups"] = [];

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
        error: "Bad Request",
        message: error.message
      });
    }

    return reply.send(error);
  });

  server.addHook("preHandler", async (request, reply) => {
    if (request.url === "/healthz" || request.url === "/api/session") {
      return;
    }
    if (!request.url.startsWith("/api/")) {
      return;
    }

    const token = request.headers["x-session-token"];
    if (token !== config.sessionToken) {
      await reply.code(401).send({ error: "Invalid local session token" });
    }
  });

  server.get("/healthz", async () => ({ ok: true }));

  server.get("/api/session", async () => ({
    token: config.sessionToken,
    accountName: config.accountName,
    apiBaseUrl: `http://${config.host}:${config.port}`,
    enableMutations: config.enableMutations,
    forceDryRun: config.forceDryRun,
    hasServiceAccountToken: Boolean(config.serviceAccountToken),
    supportsDesktopAuth: true
  }));

  server.get("/api/scan", async () => {
    if (!latestScan) {
      throw new ClientInputError("No scan has been run yet.");
    }
    return redactScanResultForClient(latestScan);
  });

  server.post("/api/scan/clear", async (_request, reply) => {
    if (activeMutationScanId) {
      return reply.code(409).send({
        error: "Conflict",
        message: "An execution is already running. Wait for it to finish before clearing the scan."
      });
    }

    latestScan = undefined;
    latestScanMode = undefined;
    latestDryRunKey = undefined;
    latestSkippedGroups = [];
    onePassword.clearCache();

    return { ok: true };
  });

  server.post("/api/scan", async (request, reply) => {
    if (activeMutationScanId) {
      return reply.code(409).send({
        error: "Conflict",
        message: "An execution is already running. Wait for it to finish before scanning again."
      });
    }

    const body = scanBodySchema.parse(request.body ?? {});
    if (body.mode === "mock") {
      latestScan = createMockScanResult();
      latestScanMode = "mock";
      latestDryRunKey = undefined;
      latestSkippedGroups = [];
      return redactScanResultForClient(latestScan);
    }

    const accountName = body.accountName || config.accountName;
    if (!config.serviceAccountToken && !accountName) {
      throw new ClientInputError("Missing 1Password account name. Set OP_ACCOUNT_NAME, enter an account name, set OP_SERVICE_ACCOUNT_TOKEN, or use mock mode.");
    }
    latestScan = await onePassword.scan({
      serviceAccountToken: config.serviceAccountToken,
      accountName
    });
    latestScanMode = "live";
    latestDryRunKey = undefined;
    latestSkippedGroups = [];
    return redactScanResultForClient(latestScan);
  });

  server.post("/api/plan", async (request) => {
    const decision = decisionSchema.parse(request.body) satisfies DecisionBody;
    const plan = createPlanFromLatestScan(decision, latestScan);
    return plan;
  });

  server.post("/api/groups/:groupId/skip", async (request, reply) => {
    if (activeMutationScanId) {
      return reply.code(409).send({
        error: "Conflict",
        message: "An execution is already running. Wait for it to finish before skipping a group."
      });
    }

    const params = groupParamsSchema.parse(request.params);
    const body = skipGroupBodySchema.parse(request.body ?? {});
    const scan = currentScanFor(body.scanId, latestScan);
    const skippedGroup = scan.groups.find((group) => group.id === params.groupId);
    if (!skippedGroup) {
      throw new ClientInputError(`Unknown duplicate group: ${params.groupId}`);
    }

    latestSkippedGroups.push(skippedGroup);
    latestScan = removeCompletedGroup(scan, params.groupId);
    latestDryRunKey = undefined;

    return {
      skippedGroupId: params.groupId,
      restorableSkippedGroupCount: latestSkippedGroups.length,
      scan: redactScanResultForClient(latestScan)
    };
  });

  server.post("/api/groups/restore-skipped", async (request, reply) => {
    if (activeMutationScanId) {
      return reply.code(409).send({
        error: "Conflict",
        message: "An execution is already running. Wait for it to finish before restoring a skipped group."
      });
    }

    const body = restoreSkippedBodySchema.parse(request.body ?? {});
    const scan = currentScanFor(body.scanId, latestScan);
    const restoredGroup = latestSkippedGroups.pop();
    if (!restoredGroup) {
      throw new ClientInputError("No skipped duplicate group can be restored.");
    }

    latestScan = {
      ...scan,
      groups: [restoredGroup, ...scan.groups]
    };
    latestDryRunKey = undefined;

    return {
      restoredGroupId: restoredGroup.id,
      restorableSkippedGroupCount: latestSkippedGroups.length,
      scan: redactScanResultForClient(latestScan)
    };
  });

  server.post("/api/execute", async (request) => {
    const decision = decisionSchema.parse(request.body) satisfies DecisionBody;
    const plan = createPlanFromLatestScan(decision, latestScan);

    if (plan.blockers.length > 0) {
      return { plan, results: [], blocked: true };
    }
    if (decision.dryRun || latestScanMode === "mock") {
      const shouldAdvanceMockScan = !decision.dryRun && latestScanMode === "mock";
      if (shouldAdvanceMockScan) {
        latestScan = removeCompletedGroup(latestScan!, decision.groupId);
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
        scan: shouldAdvanceMockScan && latestScan ? redactScanResultForClient(latestScan) : undefined
      };
    }

    const requiredDryRunKey = dryRunKeyFor(decision, plan.actions);
    if (decision.confirmedDryRunKey !== requiredDryRunKey || latestDryRunKey !== requiredDryRunKey) {
      return {
        plan,
        results: [],
        blocked: true,
        error: "Run a successful dry-run for the current plan before executing live changes."
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
        error: `Permanent delete requires typing ${permanentDeleteConfirmationPhrase}.`
      };
    }

    if (activeMutationScanId) {
      return {
        plan,
        results: [],
        blocked: true,
        error: "Another execution is already running. Wait for it to finish, then rescan before continuing."
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
      const results = await executePlanActions(plan.actions, latestScan!, onePassword);
      const hasFailure = results.some((result) => !result.ok);
      const hasMutation = results.some((result) => result.ok && result.action !== "keep");
      if (hasFailure) {
        latestScan = undefined;
        latestScanMode = undefined;
        latestDryRunKey = undefined;
        latestSkippedGroups = [];
        return { plan, results, scanInvalidated: true };
      }

      latestScan = removeCompletedGroup(latestScan!, decision.groupId);
      latestDryRunKey = undefined;
      latestSkippedGroups = [];
      return {
        plan,
        results,
        completedGroupId: decision.groupId,
        scan: redactScanResultForClient(latestScan),
        scanInvalidated: false,
        mutated: hasMutation
      };
    } finally {
      activeMutationScanId = undefined;
    }
  });

  await registerStaticUi(server, config.webDistDir);

  return server;
}

const scanBodySchema = z.object({
  accountName: z.string().min(1).optional(),
  mode: z.enum(["live", "mock"]).default("live")
});

const groupParamsSchema = z.object({
  groupId: z.string().min(1)
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

function createPlanFromLatestScan(decision: GroupDecision, latestScan: ScanResult | undefined) {
  const scan = currentScanFor(decision.scanId, latestScan);

  const group = scan.groups.find((candidate) => candidate.id === decision.groupId);
  if (!group) {
    throw new ClientInputError(`Unknown duplicate group: ${decision.groupId}`);
  }

  const consistencyBlockers = validateDecisionItemSet(decision, group.itemIds);
  const planDecision = {
    ...decision,
    items: decision.items.filter((item) => group.itemIds.includes(item.itemId))
  };
  const plan = createExecutionPlan(decision.groupId, planDecision, scan.items);
  const targetVaultBlockers = validateTargetVaults(decision, scan);
  return {
    ...plan,
    blockers: Array.from(new Set([...plan.blockers, ...consistencyBlockers, ...targetVaultBlockers]))
  };
}

function currentScanFor(scanId: string, latestScan: ScanResult | undefined): ScanResult {
  if (!latestScan) {
    throw new ClientInputError("Run a scan before creating, skipping, or executing a plan.");
  }

  if (scanId !== latestScan.scanId) {
    throw new ClientInputError("Scan is stale. Run a new scan before continuing.");
  }

  return latestScan;
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
    return "Real 1Password mutations are disabled because OP_FORCE_DRY_RUN=true is enabled. Unset it only when you are ready to modify 1Password data.";
  }
  return "Real 1Password mutations are disabled. Set OP_ENABLE_MUTATIONS=true only when you are ready to modify 1Password data.";
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
      results.push({ itemId: action.itemId, action: action.type, ok: false, error: "Unknown item" });
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
        error: error instanceof Error ? error.message : String(error)
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
    error: "Skipped because a previous action failed."
  }));
}

function redactScanResultForClient(scan: ScanResult): ScanResult {
  return {
    ...scan,
    items: scan.items.map((item) => ({
      ...item,
      comparableFields: []
    })),
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
      return reply.code(404).send({ error: "Not Found" });
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
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'"
  ].join("; ");
}
