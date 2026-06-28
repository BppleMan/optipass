import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiServer, PasswordService } from "./app.js";
import { createMockScanResult } from "./mock-data.js";

const token = "test-session-token";

function createService(): PasswordService {
  return {
    scan: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
    copyToVaultAndArchiveSource: vi.fn(),
    clearCache: vi.fn()
  };
}

function createThreeItemScanResult() {
  const scan = createMockScanResult();
  const firstGroup = scan.groups[0];
  const baseItem = scan.items.find((item) => item.id === firstGroup.itemIds[0])!;
  const thirdItem = {
    ...baseItem,
    id: "vault-archive:github-3",
    onePasswordItemId: "github-3",
    vaultId: "vault-archive",
    vaultName: "Archive",
    title: "GitHub archive copy"
  };

  return {
    ...scan,
    items: [...scan.items, thirdItem],
    groups: [
      {
        ...firstGroup,
        id: "dup-three-github",
        itemIds: [firstGroup.itemIds[0], firstGroup.itemIds[1], thirdItem.id],
        recommendedKeepIds: [thirdItem.id]
      },
      ...scan.groups.slice(1)
    ]
  };
}

async function dryRunGroup(
  app: Awaited<ReturnType<typeof createApiServer>>,
  payload: Record<string, unknown>
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/execute",
    headers: { "x-session-token": token },
    payload: {
      ...payload,
      dryRun: true
    }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().dryRun).toBe(true);
  expect(response.json().dryRunKey).toEqual(expect.any(String));
  return response.json().dryRunKey;
}

describe("api app", () => {
  let service: PasswordService;
  let app: Awaited<ReturnType<typeof createApiServer>>;

  beforeEach(async () => {
    service = createService();
    app = await createApiServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        webOrigins: ["http://127.0.0.1:4200"],
        enableMutations: true,
        forceDryRun: false,
        sessionToken: token
      },
      onePassword: service,
      logger: false
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("protects non-public endpoints with the local session token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/scan",
      payload: { mode: "mock" }
    });

    expect(response.statusCode).toBe(401);
  });

  it("limits browser CORS access to configured local web origins", async () => {
    const allowed = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:4200" }
    });
    const denied = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:9999" }
    });

    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:4200");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("adds baseline security headers to API responses", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/healthz"
    });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("object-src 'none'");
  });

  it("returns mock duplicate groups without calling 1Password", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().groups.length).toBeGreaterThan(0);
    expect(service.scan).not.toHaveBeenCalled();
  });

  it("redacts comparison-only fields from scan responses", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });

    const body = response.json();
    expect(body.items.every((item: { comparableFields: unknown[] }) => item.comparableFields.length === 0)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("AKIA-MOCK-KEY");
    expect(JSON.stringify(body)).not.toContain("mock-aws-secret");
  });

  it("clears the current scan and local item cache without calling 1Password mutations", async () => {
    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });

    const clearResponse = await app.inject({
      method: "POST",
      url: "/api/scan/clear",
      headers: { "x-session-token": token }
    });
    const afterClearResponse = await app.inject({
      method: "GET",
      url: "/api/scan",
      headers: { "x-session-token": token }
    });

    expect(scanResponse.statusCode).toBe(200);
    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toEqual({ ok: true });
    expect(afterClearResponse.statusCode).toBe(400);
    expect(afterClearResponse.json().message).toContain("No scan has been run");
    expect(service.clearCache).toHaveBeenCalledTimes(1);
    expect(service.scan).not.toHaveBeenCalled();
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("reports missing live auth configuration as a bad request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("Missing 1Password account name");
  });

  it("serves the production web UI without intercepting API routes", async () => {
    await app.close();
    const webDistDir = await mkdtemp(join(tmpdir(), "optimize-password-web-"));
    await writeFile(join(webDistDir, "index.html"), "<!doctype html><op-root></op-root>");
    await writeFile(join(webDistDir, "main.js"), "console.log('optimize-password');");

    app = await createApiServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        webOrigins: ["http://127.0.0.1:4200"],
        enableMutations: true,
        forceDryRun: false,
        sessionToken: token,
        webDistDir
      },
      onePassword: service,
      logger: false
    });

    try {
      const indexResponse = await app.inject({ method: "GET", url: "/" });
      const assetResponse = await app.inject({ method: "GET", url: "/main.js" });
      const fallbackResponse = await app.inject({ method: "GET", url: "/review/group-1" });
      const apiResponse = await app.inject({ method: "GET", url: "/api/session" });

      expect(indexResponse.statusCode).toBe(200);
      expect(indexResponse.headers["content-type"]).toContain("text/html");
      expect(indexResponse.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(indexResponse.body).toContain("<op-root>");
      expect(assetResponse.statusCode).toBe(200);
      expect(assetResponse.headers["content-type"]).toContain("text/javascript");
      expect(assetResponse.body).toContain("optimize-password");
      expect(fallbackResponse.statusCode).toBe(200);
      expect(fallbackResponse.body).toContain("<op-root>");
      expect(apiResponse.statusCode).toBe(200);
      expect(apiResponse.json().token).toBe(token);
    } finally {
      await rm(webDistDir, { recursive: true, force: true });
    }
  });

  it("blocks execution when the decision omits items from the duplicate group", async () => {
    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: {
        scanId: scan.scanId,
        groupId: group.id,
        items: [{ itemId: group.itemIds[0], keep: true }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().blocked).toBe(true);
    expect(response.json().plan.blockers.join("\n")).toContain("执行请求缺少组内 item");
  });

  it("blocks unknown decision item ids without raising a server error", async () => {
    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: {
        scanId: scan.scanId,
        groupId: group.id,
        items: [
          ...group.itemIds.map((itemId: string, index: number) => ({
            itemId,
            keep: index === 0
          })),
          { itemId: "vault-forged:item-not-in-scan", keep: false }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().blocked).toBe(true);
    expect(response.json().plan.blockers.join("\n")).toContain("执行请求包含不属于该组的 item：vault-forged:item-not-in-scan");
    expect(response.json().plan.actions.every((action: { itemId: string }) => group.itemIds.includes(action.itemId))).toBe(true);
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("blocks plans that target an unknown vault", async () => {
    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: {
        scanId: scan.scanId,
        groupId: group.id,
        items: group.itemIds.map((itemId: string, index: number) => ({
          itemId,
          keep: index === 0,
          targetVaultId: index === 0 ? "vault-not-in-scan" : undefined
        }))
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().blocked).toBe(true);
    expect(response.json().plan.blockers.join("\n")).toContain("目标保险库不存在或不可访问：vault-not-in-scan");
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("uses no-op dry-run execution for mock scans", async () => {
    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: {
        scanId: scan.scanId,
        groupId: group.id,
        items: group.itemIds.map((itemId: string, index: number) => ({
          itemId,
          keep: index === 0
        }))
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().dryRun).toBe(true);
    expect(response.json().results.every((result: { dryRun?: boolean }) => result.dryRun)).toBe(true);
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
  });

  it("skips a duplicate group from the current scan without calling 1Password", async () => {
    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];

    const response = await app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/skip`,
      headers: { "x-session-token": token },
      payload: { scanId: scan.scanId }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().skippedGroupId).toBe(group.id);
    expect(response.json().restorableSkippedGroupCount).toBe(1);
    expect(response.json().scan.groups).toHaveLength(scan.groups.length - 1);
    expect(response.json().scan.groups.some((candidate: { id: string }) => candidate.id === group.id)).toBe(false);
    expect(service.scan).not.toHaveBeenCalled();
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("restores the most recently skipped duplicate group without calling 1Password", async () => {
    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];

    await app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/skip`,
      headers: { "x-session-token": token },
      payload: { scanId: scan.scanId }
    });
    const restoreResponse = await app.inject({
      method: "POST",
      url: "/api/groups/restore-skipped",
      headers: { "x-session-token": token },
      payload: { scanId: scan.scanId }
    });

    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().restoredGroupId).toBe(group.id);
    expect(restoreResponse.json().restorableSkippedGroupCount).toBe(0);
    expect(restoreResponse.json().scan.groups).toHaveLength(scan.groups.length);
    expect(restoreResponse.json().scan.groups[0].id).toBe(group.id);
    expect(service.scan).not.toHaveBeenCalled();
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("reports when no skipped group can be restored", async () => {
    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });
    const scan = scanResponse.json();

    const response = await app.inject({
      method: "POST",
      url: "/api/groups/restore-skipped",
      headers: { "x-session-token": token },
      payload: { scanId: scan.scanId }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("No skipped duplicate group");
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("clears skipped-group restore state after completing a mock group", async () => {
    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });
    const scan = scanResponse.json();
    const skippedGroup = scan.groups[0];
    const skipResponse = await app.inject({
      method: "POST",
      url: `/api/groups/${skippedGroup.id}/skip`,
      headers: { "x-session-token": token },
      payload: { scanId: scan.scanId }
    });
    const currentScan = skipResponse.json().scan;
    const group = currentScan.groups[0];

    const executeResponse = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: {
        scanId: currentScan.scanId,
        groupId: group.id,
        items: group.itemIds.map((itemId: string, index: number) => ({
          itemId,
          keep: index === 0
        }))
      }
    });
    const restoreResponse = await app.inject({
      method: "POST",
      url: "/api/groups/restore-skipped",
      headers: { "x-session-token": token },
      payload: { scanId: currentScan.scanId }
    });

    expect(skipResponse.statusCode).toBe(200);
    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json().completedGroupId).toBe(group.id);
    expect(restoreResponse.statusCode).toBe(400);
    expect(restoreResponse.json().message).toContain("No skipped duplicate group");
    expect(service.scan).not.toHaveBeenCalled();
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("allows live dry-run for permanent-delete plans without mutating items", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());

    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: {
        scanId: scan.scanId,
        groupId: group.id,
        dryRun: true,
        items: group.itemIds.map((itemId: string, index: number) => ({
          itemId,
          keep: index === 0,
          deleteMode: index === 0 ? "archive" : "delete"
        }))
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().dryRun).toBe(true);
    expect(response.json().dryRunKey).toEqual(expect.any(String));
    expect(response.json().blocked).toBeUndefined();
    expect(response.json().plan.requiresExplicitDeleteConfirmation).toBe(true);
    expect(response.json().results.every((result: { dryRun?: boolean }) => result.dryRun)).toBe(true);
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("rejects plans and execution for stale scan ids", async () => {
    const firstScanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });
    const firstScan = firstScanResponse.json();
    const group = firstScan.groups[0];

    const secondScanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "mock" }
    });
    expect(secondScanResponse.json().scanId).not.toBe(firstScan.scanId);

    const payload = {
      scanId: firstScan.scanId,
      groupId: group.id,
      items: group.itemIds.map((itemId: string, index: number) => ({
        itemId,
        keep: index === 0
      }))
    };

    const planResponse = await app.inject({
      method: "POST",
      url: "/api/plan",
      headers: { "x-session-token": token },
      payload
    });
    const executeResponse = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload
    });

    expect(planResponse.statusCode).toBe(400);
    expect(executeResponse.statusCode).toBe(400);
    expect(planResponse.json().message).toContain("Scan is stale");
    expect(executeResponse.json().message).toContain("Scan is stale");
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
  });

  it("blocks live execution until the current plan has a successful dry-run", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());

    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: {
        scanId: scan.scanId,
        groupId: group.id,
        items: group.itemIds.map((itemId: string, index: number) => ({
          itemId,
          keep: index === 0
        }))
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().blocked).toBe(true);
    expect(response.json().error).toContain("dry-run");
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("blocks live mutations unless they are explicitly enabled", async () => {
    await app.close();
    service = createService();
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    app = await createApiServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        webOrigins: ["http://127.0.0.1:4200"],
        enableMutations: false,
        forceDryRun: false,
        sessionToken: token
      },
      onePassword: service,
      logger: false
    });

    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];
    const payload = {
      scanId: scan.scanId,
      groupId: group.id,
      items: group.itemIds.map((itemId: string, index: number) => ({
        itemId,
        keep: index === 0
      }))
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().blocked).toBe(true);
    expect(response.json().error).toContain("mutations are disabled");
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("normalizes live action order before dry-run approval and execution", async () => {
    vi.mocked(service.scan).mockResolvedValue(createThreeItemScanResult());
    vi.mocked(service.archive).mockResolvedValue(undefined);
    vi.mocked(service.delete).mockResolvedValue(undefined);

    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];
    const originalPayload = {
      scanId: scan.scanId,
      groupId: group.id,
      items: [
        { itemId: group.itemIds[0], keep: false, deleteMode: "archive" },
        { itemId: group.itemIds[1], keep: false, deleteMode: "delete" },
        { itemId: group.itemIds[2], keep: true }
      ]
    };
    const confirmedDryRunKey = await dryRunGroup(app, originalPayload);

    const reorderedResponse = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: {
        scanId: scan.scanId,
        groupId: group.id,
        confirmPermanentDelete: true,
        permanentDeleteConfirmationPhrase: "永久删除",
        confirmedDryRunKey,
        items: [
          { itemId: group.itemIds[1], keep: false, deleteMode: "delete" },
          { itemId: group.itemIds[0], keep: false, deleteMode: "archive" },
          { itemId: group.itemIds[2], keep: true }
        ]
      }
    });

    expect(reorderedResponse.statusCode).toBe(200);
    expect(reorderedResponse.json().blocked).toBeUndefined();
    expect(reorderedResponse.json().results.map((result: { action: string }) => result.action)).toEqual([
      "keep",
      "archive",
      "delete"
    ]);
    expect(service.archive).toHaveBeenCalledTimes(1);
    expect(service.delete).toHaveBeenCalledTimes(1);
    expect(vi.mocked(service.archive).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(service.delete).mock.invocationCallOrder[0]
    );
  });

  it("requires the permanent-delete confirmation phrase for live delete execution", async () => {
    vi.mocked(service.scan).mockResolvedValue(createThreeItemScanResult());

    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];
    const payload = {
      scanId: scan.scanId,
      groupId: group.id,
      items: [
        { itemId: group.itemIds[0], keep: false, deleteMode: "archive" },
        { itemId: group.itemIds[1], keep: false, deleteMode: "delete" },
        { itemId: group.itemIds[2], keep: true }
      ]
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: {
        ...payload,
        confirmPermanentDelete: true,
        confirmedDryRunKey
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().blocked).toBe(true);
    expect(response.json().error).toContain("永久删除");
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("blocks concurrent live mutations for the active scan", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    let releaseArchive!: () => void;
    vi.mocked(service.archive).mockReturnValue(new Promise<void>((resolve) => {
      releaseArchive = resolve;
    }));

    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];
    const payload = {
      scanId: scan.scanId,
      groupId: group.id,
      items: group.itemIds.map((itemId: string, index: number) => ({
        itemId,
        keep: index === 0
      }))
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);

    const firstExecute = app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });
    await vi.waitFor(() => {
      expect(service.archive).toHaveBeenCalledTimes(1);
    });

    const secondExecute = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });

    expect(secondExecute.statusCode).toBe(200);
    expect(secondExecute.json().blocked).toBe(true);
    expect(secondExecute.json().error).toContain("Another execution is already running");
    expect(service.archive).toHaveBeenCalledTimes(1);

    releaseArchive();
    const firstExecuteResponse = await firstExecute;
    expect(firstExecuteResponse.statusCode).toBe(200);
    expect(firstExecuteResponse.json().scanInvalidated).toBe(false);
    expect(firstExecuteResponse.json().completedGroupId).toBe(group.id);
  });

  it("rejects scans while a live mutation is running", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    let releaseArchive!: () => void;
    vi.mocked(service.archive).mockReturnValue(new Promise<void>((resolve) => {
      releaseArchive = resolve;
    }));

    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];
    const payload = {
      scanId: scan.scanId,
      groupId: group.id,
      items: group.itemIds.map((itemId: string, index: number) => ({
        itemId,
        keep: index === 0
      }))
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);

    const firstExecute = app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });
    await vi.waitFor(() => {
      expect(service.archive).toHaveBeenCalledTimes(1);
    });

    const rescanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });

    expect(rescanResponse.statusCode).toBe(409);
    expect(rescanResponse.json().message).toContain("execution is already running");
    expect(service.scan).toHaveBeenCalledTimes(1);

    releaseArchive();
    await firstExecute;
  });

  it("keeps the live scan usable after a group is completed successfully", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    vi.mocked(service.archive).mockResolvedValue(undefined);

    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];
    const nextGroup = scan.groups[1];
    const payload = {
      scanId: scan.scanId,
      groupId: group.id,
      items: group.itemIds.map((itemId: string, index: number) => ({
        itemId,
        keep: index === 0
      }))
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);

    const executeResponse = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });
    const completedGroupPlanResponse = await app.inject({
      method: "POST",
      url: "/api/plan",
      headers: { "x-session-token": token },
      payload: {
        scanId: scan.scanId,
        groupId: group.id,
        items: group.itemIds.map((itemId: string, index: number) => ({
          itemId,
          keep: index === 0
        }))
      }
    });
    const nextGroupPlanResponse = await app.inject({
      method: "POST",
      url: "/api/plan",
      headers: { "x-session-token": token },
      payload: {
        scanId: scan.scanId,
        groupId: nextGroup.id,
        items: nextGroup.itemIds.map((itemId: string, index: number) => ({
          itemId,
          keep: index === 0
        }))
      }
    });

    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json().scanInvalidated).toBe(false);
    expect(executeResponse.json().completedGroupId).toBe(group.id);
    expect(executeResponse.json().scan.groups).toHaveLength(scan.groups.length - 1);
    expect(service.archive).toHaveBeenCalled();
    expect(completedGroupPlanResponse.statusCode).toBe(400);
    expect(completedGroupPlanResponse.json().message).toContain("Unknown duplicate group");
    expect(nextGroupPlanResponse.statusCode).toBe(200);
  });

  it("clears skipped-group restore state after completing a live group", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    vi.mocked(service.archive).mockResolvedValue(undefined);

    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const scan = scanResponse.json();
    const skippedGroup = scan.groups[0];
    const skipResponse = await app.inject({
      method: "POST",
      url: `/api/groups/${skippedGroup.id}/skip`,
      headers: { "x-session-token": token },
      payload: { scanId: scan.scanId }
    });
    const currentScan = skipResponse.json().scan;
    const group = currentScan.groups[0];
    const payload = {
      scanId: currentScan.scanId,
      groupId: group.id,
      items: group.itemIds.map((itemId: string, index: number) => ({
        itemId,
        keep: index === 0
      }))
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);

    const executeResponse = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });
    const restoreResponse = await app.inject({
      method: "POST",
      url: "/api/groups/restore-skipped",
      headers: { "x-session-token": token },
      payload: { scanId: currentScan.scanId }
    });

    expect(skipResponse.statusCode).toBe(200);
    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json().scanInvalidated).toBe(false);
    expect(executeResponse.json().completedGroupId).toBe(group.id);
    expect(restoreResponse.statusCode).toBe(400);
    expect(restoreResponse.json().message).toContain("No skipped duplicate group");
    expect(service.archive).toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("invalidates live scan state after a failed mutation", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    vi.mocked(service.archive).mockRejectedValue(new Error("archive failed"));

    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];
    const payload = {
      scanId: scan.scanId,
      groupId: group.id,
      items: group.itemIds.map((itemId: string, index: number) => ({
        itemId,
        keep: index === 0
      }))
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);

    const executeResponse = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });
    const planAfterFailureResponse = await app.inject({
      method: "POST",
      url: "/api/plan",
      headers: { "x-session-token": token },
      payload: {
        scanId: scan.scanId,
        groupId: group.id,
        items: group.itemIds.map((itemId: string, index: number) => ({
          itemId,
          keep: index === 0
        }))
      }
    });

    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json().scanInvalidated).toBe(true);
    expect(executeResponse.json().results.some((result: { ok: boolean }) => !result.ok)).toBe(true);
    expect(planAfterFailureResponse.statusCode).toBe(400);
    expect(planAfterFailureResponse.json().message).toContain("Run a scan");
  });

  it("stops live execution after the first failed mutation", async () => {
    vi.mocked(service.scan).mockResolvedValue(createThreeItemScanResult());
    vi.mocked(service.archive).mockRejectedValue(new Error("archive failed"));

    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const scan = scanResponse.json();
    const group = scan.groups[0];
    const payload = {
      scanId: scan.scanId,
      groupId: group.id,
      confirmPermanentDelete: true,
      permanentDeleteConfirmationPhrase: "永久删除",
      items: [
        { itemId: group.itemIds[0], keep: false, deleteMode: "archive" },
        { itemId: group.itemIds[1], keep: false, deleteMode: "delete" },
        { itemId: group.itemIds[2], keep: true }
      ]
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.scanInvalidated).toBe(true);
    expect(body.results).toEqual([
      expect.objectContaining({ itemId: group.itemIds[2], action: "keep", ok: true }),
      expect.objectContaining({ itemId: group.itemIds[0], action: "archive", ok: false }),
      expect.objectContaining({ itemId: group.itemIds[1], action: "delete", ok: false, skipped: true })
    ]);
    expect(service.archive).toHaveBeenCalledTimes(1);
    expect(service.delete).not.toHaveBeenCalled();
  });
});
