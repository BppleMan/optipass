import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScanProgress, ScanResult, ScanSnapshot } from "@optimize-password/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiServer, PasswordService } from "./app.js";
import { createMockScanResult } from "./mock-data.js";

const token = "test-session-token";
type ApiServer = Awaited<ReturnType<typeof createApiServer>>;

function createService(): PasswordService {
  return {
    scan: vi.fn(),
    revealCredentials: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
    removeTags: vi.fn(),
    copyToVaultAndArchiveSource: vi.fn(),
    listItemStates: vi.fn(),
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
  app: ApiServer,
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

async function startScan(
  app: ApiServer,
  payload: Record<string, unknown>
): Promise<{ scanId: string; mode: string; progress: ScanProgress; eventsToken: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/scan",
    headers: { "x-session-token": token },
    payload
  });

  expect(response.statusCode).toBe(200);
  return response.json();
}

async function waitForScan(app: ApiServer, scanId: string): Promise<ScanSnapshot> {
  let snapshot: ScanSnapshot | undefined;
  await vi.waitFor(async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/scan",
      headers: { "x-session-token": token }
    });
    expect(response.statusCode).toBe(200);
    snapshot = response.json();
    expect(snapshot.scanId).toBe(scanId);
  });
  return snapshot!;
}

async function scanAndAnalyze(app: ApiServer, payload: Record<string, unknown>): Promise<ScanResult> {
  const start = await startScan(app, payload);
  await waitForScan(app, start.scanId);
  const response = await app.inject({
    method: "POST",
    url: "/api/analyze",
    headers: { "x-session-token": token },
    payload: { scanId: start.scanId }
  });

  expect(response.statusCode).toBe(200);
  return response.json();
}

function decisionForGroup(scan: ScanResult, group: ScanResult["groups"][number]): Record<string, unknown> {
  return {
    scanId: scan.scanId,
    groupId: group.id,
    items: group.itemIds.map((itemId, index) => ({
      itemId,
      keep: index === 0,
      deleteMode: "archive"
    }))
  };
}

function sseEvent(body: string, type: string): unknown {
  const block = body.split("\n\n").find((candidate) => candidate.includes(`event: ${type}\n`));
  const data = block?.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  if (!data) {
    throw new Error(`找不到 SSE 事件：${type}`);
  }
  return JSON.parse(data);
}

function mockArchiveGroupVerification(service: PasswordService, scan: ScanResult, group: ScanResult["groups"][number]): void {
  const groupItems = group.itemIds.map((itemId) => scan.items.find((item) => item.id === itemId)!);
  const keepItem = groupItems[0];
  const archivedItems = groupItems.slice(1);
  const callsByVault = new Map<string, number>();
  vi.mocked(service.listItemStates).mockImplementation(async (vaultId: string) => {
    const callCount = callsByVault.get(vaultId) ?? 0;
    callsByVault.set(vaultId, callCount + 1);
    const vaultItems = groupItems.filter((item) => item.vaultId === vaultId);
    const vaultArchivedItems = archivedItems.filter((item) => item.vaultId === vaultId);
    if (callCount === 0) {
      return {
        activeIds: vaultItems.map((item) => item.onePasswordItemId),
        archivedIds: []
      };
    }
    return {
      activeIds: keepItem.vaultId === vaultId ? [keepItem.onePasswordItemId] : [],
      archivedIds: vaultArchivedItems.map((item) => item.onePasswordItemId)
    };
  });
}

function mockVaultStateReadSequence(
  service: PasswordService,
  states: Array<Record<string, { activeIds: string[]; archivedIds: string[] }>>
): void {
  let index = 0;
  vi.mocked(service.listItemStates).mockImplementation(async (vaultId: string) => {
    const state = states[Math.min(index, states.length - 1)]?.[vaultId] ?? { activeIds: [], archivedIds: [] };
    index += 1;
    return state;
  });
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

  it("executes a batch ActionDraft in dry-run mode and refreshes the unchanged draft", async () => {
    const scan = await scanAndAnalyze(app, { mode: "mock" });
    const groups = scan.groups.slice(0, 2);
    const draft = {
      scanId: scan.scanId,
      groups: groups.map((group) => decisionForGroup(scan, group))
    };
    const start = await app.inject({
      method: "POST",
      url: "/api/action-executions/start",
      headers: { "x-session-token": token },
      payload: { draft }
    });

    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ writeEnabled: false, totalGroups: 2, status: "running" });
    const events = await app.inject({
      method: "GET",
      url: `/api/action-executions/${start.json().executionId}/events?eventsToken=${start.json().eventsToken}`
    });
    expect(events.statusCode).toBe(200);
    expect(events.body).toContain("event: action-started");
    expect(events.body).toContain("event: refreshed");
    expect(events.body).toContain("event: completed");
    const snapshot = await app.inject({
      method: "GET",
      url: `/api/action-executions/${start.json().executionId}`,
      headers: { "x-session-token": token }
    });
    expect(snapshot.json()).toMatchObject({ status: "completed", writeEnabled: false });
    expect(snapshot.json().draft.groups.map((group: { items: Array<Record<string, unknown>> }) => group.items.map((item) => ({
      itemId: item.itemId,
      keep: item.keep,
      deleteMode: item.deleteMode
    })))).toEqual(draft.groups.map((group) => group.items));

    const refreshed = sseEvent(events.body, "refreshed") as { response: { draft: Record<string, unknown> } };
    const restarted = await app.inject({
      method: "POST",
      url: "/api/action-executions/start",
      headers: { "x-session-token": token },
      payload: { draft: refreshed.response.draft }
    });
    expect(restarted.statusCode).toBe(200);
    const restartedEvents = await app.inject({
      method: "GET",
      url: `/api/action-executions/${restarted.json().executionId}/events?eventsToken=${restarted.json().eventsToken}`
    });
    expect(restartedEvents.body).toContain("event: completed");
  });

  it("does not rescan 1Password after a live dry-run batch", async () => {
    await app.close();
    service = createService();
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    app = await createApiServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        webOrigins: ["http://127.0.0.1:4200"],
        enableMutations: false,
        sessionToken: token,
        accountName: "test-account"
      },
      onePassword: service,
      logger: false
    });
    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "test-account" });
    const group = scan.groups[0];
    const start = await app.inject({
      method: "POST",
      url: "/api/action-executions/start",
      headers: { "x-session-token": token },
      payload: { draft: { scanId: scan.scanId, groups: [decisionForGroup(scan, group)] } }
    });
    const events = await app.inject({
      method: "GET",
      url: `/api/action-executions/${start.json().executionId}/events?eventsToken=${start.json().eventsToken}`
    });
    const refreshed = sseEvent(events.body, "refreshed") as { response: { scan: ScanResult } };

    expect(refreshed.response.scan.scanId).toBe(scan.scanId);
    expect(refreshed.response.scan.items).toEqual(scan.items);
    expect(service.scan).toHaveBeenCalledTimes(1);
  });

  it("projects successful writes into memory instead of rescanning 1Password", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "test-account" });
    const group = scan.groups[0];
    const archiveItem = scan.items.find((item) => item.id === group.itemIds[1])!;
    mockArchiveGroupVerification(service, scan, group);
    const start = await app.inject({
      method: "POST",
      url: "/api/action-executions/start",
      headers: { "x-session-token": token },
      payload: { draft: { scanId: scan.scanId, groups: [decisionForGroup(scan, group)] } }
    });
    const events = await app.inject({
      method: "GET",
      url: `/api/action-executions/${start.json().executionId}/events?eventsToken=${start.json().eventsToken}`
    });
    const refreshed = sseEvent(events.body, "refreshed") as { response: { scan: ScanResult } };

    expect(events.body).toContain("event: completed");
    expect(refreshed.response.scan.scanId).not.toBe(scan.scanId);
    expect(refreshed.response.scan.items.some((item) => item.id === archiveItem.id)).toBe(false);
    expect(service.scan).toHaveBeenCalledTimes(1);
  });

  it("pauses after the running action, resumes the same execution, and can stop it", async () => {
    await app.close();
    const liveScan = createMockScanResult();
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    vi.mocked(service.scan).mockResolvedValue(liveScan);
    vi.mocked(service.archive).mockImplementationOnce(async () => archiveGate);
    vi.mocked(service.listItemStates).mockResolvedValue({
      activeIds: liveScan.items.map((item) => item.onePasswordItemId),
      archivedIds: []
    });
    app = await createApiServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        webOrigins: ["http://127.0.0.1:4200"],
        enableMutations: true,
        sessionToken: token,
        accountName: "test-account"
      },
      onePassword: service,
      logger: false
    });
    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "test-account" });
    const group = scan.groups[0];
    const start = await app.inject({
      method: "POST",
      url: "/api/action-executions/start",
      headers: { "x-session-token": token },
      payload: { draft: { scanId: scan.scanId, groups: [decisionForGroup(scan, group)] } }
    });
    const executionId = start.json().executionId;
    await vi.waitFor(() => expect(service.archive).toHaveBeenCalledTimes(1));
    const pause = await app.inject({
      method: "POST",
      url: `/api/action-executions/${executionId}/pause`,
      headers: { "x-session-token": token }
    });
    expect(pause.json().status).toBe("pause-requested");
    releaseArchive();
    await vi.waitFor(async () => {
      const snapshot = await app.inject({
        method: "GET",
        url: `/api/action-executions/${executionId}`,
        headers: { "x-session-token": token }
      });
      expect(snapshot.json().status).toBe("paused");
    });
    const resume = await app.inject({
      method: "POST",
      url: `/api/action-executions/${executionId}/resume`,
      headers: { "x-session-token": token }
    });
    expect(resume.statusCode).toBe(200);
    const stop = await app.inject({
      method: "POST",
      url: `/api/action-executions/${executionId}/stop`,
      headers: { "x-session-token": token }
    });
    expect(["stop-requested", "refreshing-after-stop", "stopped"]).toContain(stop.json().status);
    await vi.waitFor(async () => {
      const snapshot = await app.inject({
        method: "GET",
        url: `/api/action-executions/${executionId}`,
        headers: { "x-session-token": token }
      });
      expect(snapshot.json().status).toBe("stopped");
    });
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

  it("allows mutation mode PATCH requests through CORS preflight", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/session/mutations",
      headers: {
        origin: "http://127.0.0.1:4200",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "x-session-token,x-tab-id,content-type"
      }
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:4200");
    expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
  });

  it("describes the local session mode and runtime capabilities", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/session"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token,
      mode: "browser-dev",
      enableMutations: true,
      hasServiceAccountToken: false,
      supportsDesktopAuth: true,
      idleShutdownMs: null,
      capabilities: {
        staticUi: false,
        canShutdown: false,
        supportsHeartbeat: false,
        supportsIdleShutdown: false,
        supportsDesktopAuth: true,
        shell: "browser"
      }
    });
    expect(JSON.stringify(response.json())).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
  });

  it("toggles live mutation capability at runtime", async () => {
    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/session/mutations",
      headers: { "x-session-token": token },
      payload: { enableMutations: false }
    });
    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/session/mutations",
      headers: { "x-session-token": token },
      payload: { enableMutations: true }
    });

    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().enableMutations).toBe(false);
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().enableMutations).toBe(true);
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
    expect(response.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
    expect(response.headers["content-security-policy"]).toContain("style-src 'self' 'unsafe-inline'");
    expect(response.headers["content-security-policy"]).toContain("object-src 'none'");
  });

  it("starts mock scans without analyzing until requested", async () => {
    const start = await startScan(app, { mode: "mock" });
    const snapshot = await waitForScan(app, start.scanId);
    const analyzeResponse = await app.inject({
      method: "POST",
      url: "/api/analyze",
      headers: { "x-session-token": token },
      payload: { scanId: start.scanId }
    });

    expect(start).not.toHaveProperty("groups");
    expect(start.progress.phase).toBe("completed");
    expect(snapshot.items.length).toBeGreaterThan(0);
    expect(snapshot).not.toHaveProperty("groups");
    expect(analyzeResponse.statusCode).toBe(200);
    expect(analyzeResponse.json().groups.length).toBeGreaterThan(0);
    expect(service.scan).not.toHaveBeenCalled();
  });

  it("redacts comparison-only fields from scan responses", async () => {
    const start = await startScan(app, { mode: "mock" });
    const body = await waitForScan(app, start.scanId);

    expect(body.items.flatMap((item: { comparableFields: Array<{ normalizedValue?: string; normalizedValueHash?: string }> }) => item.comparableFields)
      .every((field: { normalizedValue?: string; normalizedValueHash?: string }) => field.normalizedValue === undefined && field.normalizedValueHash === undefined)).toBe(true);
    expect(body.items.every((item: { analysis?: unknown }) => item.analysis === undefined)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("AKIA-MOCK-KEY");
    expect(JSON.stringify(body)).not.toContain("mock-aws-secret");
    expect(JSON.stringify(body)).not.toContain("mock-analysis");
  });

  it("searches category values and sensitive local fields without returning their values", async () => {
    const start = await startScan(app, { mode: "mock" });
    await waitForScan(app, start.scanId);

    const response = await app.inject({
      method: "POST",
      url: "/api/items/search",
      headers: { "x-session-token": token },
      payload: { keywords: ["2026", "Personal", "github.com", "recovery", "vpn@example.com", "13800000000", "一次性密码"] }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.itemIds).toEqual(expect.arrayContaining([
      "vault-personal:github-1",
      "vault-work:github-2",
      "vault-work:note-1"
    ]));
    expect(body.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "year", label: "2026" }),
      expect.objectContaining({ kind: "vault", label: "Personal" }),
      expect.objectContaining({ kind: "credential", label: "一次性密码" }),
      expect.objectContaining({ kind: "domain", label: "github.com" }),
      expect.objectContaining({ kind: "field", label: "VPN recovery note", field: "title" }),
      expect.objectContaining({ kind: "field", label: "VPN recovery note", field: "note" }),
      expect.objectContaining({ kind: "field", label: "VPN recovery note", field: "email" }),
      expect.objectContaining({ kind: "field", label: "VPN recovery note", field: "phone" })
    ]));
    expect(response.body).not.toContain("vpn recovery note");
    expect(response.body).not.toContain("vpn@example.com");
    expect(response.body).not.toContain("13800000000");
  });

  it("streams scan progress events with a completed snapshot", async () => {
    const start = await startScan(app, { mode: "mock" });
    const response = await app.inject({
      method: "GET",
      url: `/api/scan/events?scanId=${start.scanId}&eventsToken=${start.eventsToken}`,
      headers: { "x-session-token": token }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: started");
    expect(response.body).toContain("event: completed");
    expect(response.body).toContain("\"scan\"");
    expect(response.body).not.toContain("AKIA-MOCK-KEY");
  });

  it("continues scan event streams after a known event index", async () => {
    const start = await startScan(app, { mode: "mock" });
    await waitForScan(app, start.scanId);

    const response = await app.inject({
      method: "GET",
      url: `/api/scan/events?scanId=${start.scanId}&eventsToken=${start.eventsToken}&after=1`
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("event: started");
    expect(response.body).toContain("event: completed");
  });

  it("reports the active scan job for another tab to follow", async () => {
    vi.mocked(service.scan).mockImplementation(() => new Promise(() => {
    }));
    const start = await startScan(app, { mode: "live", accountName: "example-account" });

    const response = await app.inject({
      method: "GET",
      url: "/api/scan/active",
      headers: { "x-session-token": token, "x-tab-id": "second-tab" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scanId: start.scanId,
      mode: "live",
      eventsToken: start.eventsToken,
      eventCount: expect.any(Number)
    });
    expect(response.json().progress.scanId).toBe(start.scanId);
  });

  it("allows scan event streams with the per-scan events token", async () => {
    const start = await startScan(app, { mode: "mock" });
    const response = await app.inject({
      method: "GET",
      url: `/api/scan/events?scanId=${start.scanId}&eventsToken=${start.eventsToken}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: started");
    expect(response.body).toContain("event: completed");
  });

  it("adds CORS headers to scan event streams for configured origins", async () => {
    const start = await startScan(app, { mode: "mock" });
    const response = await app.inject({
      method: "GET",
      url: `/api/scan/events?scanId=${start.scanId}&eventsToken=${start.eventsToken}`,
      headers: { origin: "http://127.0.0.1:4200" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:4200");
  });

  it("rejects scan event streams with an invalid events token", async () => {
    const start = await startScan(app, { mode: "mock" });
    const response = await app.inject({
      method: "GET",
      url: `/api/scan/events?scanId=${start.scanId}&eventsToken=wrong-token`
    });

    expect(response.statusCode).toBe(401);
  });

  it("streams backend-selected dry-run execution events without calling 1Password mutations", async () => {
    const scan = await scanAndAnalyze(app, { mode: "mock" });
    const group = scan.groups[0];
    const start = await app.inject({
      method: "POST",
      url: "/api/execute/start",
      headers: { "x-session-token": token },
      payload: decisionForGroup(scan, group)
    });

    expect(start.statusCode).toBe(200);
    expect(start.json().dryRun).toBe(true);
    const stream = await app.inject({
      method: "GET",
      url: `/api/execute/events?executionId=${start.json().executionId}&eventsToken=${start.json().eventsToken}`
    });

    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain("event: started");
    expect(stream.body).toContain("event: action-started");
    expect(stream.body).toContain("event: action");
    expect(stream.body).toContain("event: completed");
    expect(stream.body).toContain("id: 1");
    expect(stream.body.indexOf("event: action-started")).toBeLessThan(stream.body.indexOf("event: action\n"));
    const resumedStream = await app.inject({
      method: "GET",
      url: `/api/execute/events?executionId=${start.json().executionId}&eventsToken=${start.json().eventsToken}`,
      headers: { "last-event-id": "1" }
    });
    expect(resumedStream.body).not.toContain("event: started\n");
    expect(resumedStream.body).toContain("event: action-started");
    expect(vi.mocked(service.archive)).not.toHaveBeenCalled();
    expect(vi.mocked(service.delete)).not.toHaveBeenCalled();
  });

  it("clears the current scan and local item cache without calling 1Password mutations", async () => {
    const scanResponse = await startScan(app, { mode: "mock" });
    await waitForScan(app, scanResponse.scanId);

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

    expect(scanResponse.scanId).toEqual(expect.any(String));
    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toEqual({ ok: true });
    expect(afterClearResponse.statusCode).toBe(400);
    expect(afterClearResponse.json().message).toContain("还没有扫描结果");
    expect(service.clearCache).toHaveBeenCalledTimes(1);
    expect(service.scan).not.toHaveBeenCalled();
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("reports missing live desktop auth account as a bad request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("Desktop App 授权需要账户名或 account_uuid");
  });

  it("exposes the completed Desktop Auth account for scan-cache recovery", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());

    const start = await startScan(app, { mode: "live", accountName: "example-account" });
    await waitForScan(app, start.scanId);

    const resumedSession = await app.inject({ method: "GET", url: "/api/session" });
    expect(resumedSession.statusCode).toBe(200);
    expect(resumedSession.json()).toMatchObject({ resumeAccountName: "example-account" });

    await app.inject({
      method: "POST",
      url: "/api/scan/clear",
      headers: { "x-session-token": token }
    });

    const clearedSession = await app.inject({ method: "GET", url: "/api/session" });
    expect(clearedSession.json()).not.toHaveProperty("resumeAccountName");
  });

  it("rejects a new scan while another scan is still running", async () => {
    vi.mocked(service.scan).mockImplementation(() => new Promise(() => {
    }));

    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json().message).toContain("当前已有执行任务正在运行");
    expect(service.scan).toHaveBeenCalledTimes(1);
  });

  it("cancels an active scan when clearing scan state", async () => {
    let resolveLiveScan!: (scan: ScanSnapshot) => void;
    vi.mocked(service.scan).mockImplementationOnce(() => new Promise((resolve) => {
      resolveLiveScan = resolve;
    }));

    const liveStart = await startScan(app, { mode: "live", accountName: "example-account" });
    const clearResponse = await app.inject({
      method: "POST",
      url: "/api/scan/clear",
      headers: { "x-session-token": token }
    });
    const mockStart = await startScan(app, { mode: "mock" });
    const mockScan = await waitForScan(app, mockStart.scanId);

    resolveLiveScan(createMockScanResult());
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/scan",
        headers: { "x-session-token": token }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().scanId).toBe(mockStart.scanId);
    });

    expect(liveStart.scanId).not.toBe(mockStart.scanId);
    expect(clearResponse.statusCode).toBe(200);
    expect(mockScan.scanId).toBe(mockStart.scanId);
    expect(service.clearCache).toHaveBeenCalledTimes(1);
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
      expect(indexResponse.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
      expect(indexResponse.headers["content-security-policy"]).toContain("style-src 'self' 'unsafe-inline'");
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

  it("protects heartbeat and shutdown with the local session token", async () => {
    const heartbeatResponse = await app.inject({
      method: "POST",
      url: "/api/session/heartbeat"
    });
    const shutdownResponse = await app.inject({
      method: "POST",
      url: "/api/session/shutdown"
    });

    expect(heartbeatResponse.statusCode).toBe(401);
    expect(shutdownResponse.statusCode).toBe(401);
  });

  it("allows launcher-managed shutdown when no scan or mutation is running", async () => {
    await app.close();
    const onShutdown = vi.fn();
    app = await createApiServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        mode: "browser-serve",
        webOrigins: ["http://127.0.0.1:4200"],
        enableMutations: true,
        sessionToken: token,
        idleShutdownMs: 5000
      },
      onePassword: service,
      lifecycle: {
        shutdown: {
          enabled: true,
          onShutdown
        }
      },
      logger: false
    });

    const sessionResponse = await app.inject({ method: "GET", url: "/api/session" });
    const shutdownResponse = await app.inject({
      method: "POST",
      url: "/api/session/shutdown",
      headers: { "x-session-token": token }
    });

    expect(sessionResponse.json()).toMatchObject({
      mode: "browser-serve",
      idleShutdownMs: 5000,
      capabilities: {
        canShutdown: true,
        supportsHeartbeat: true,
        supportsIdleShutdown: true
      }
    });
    expect(shutdownResponse.statusCode).toBe(200);
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledWith("requested"));
  });

  it("refuses shutdown while a scan is still running", async () => {
    await app.close();
    vi.mocked(service.scan).mockImplementation(() => new Promise(() => {
    }));
    const onShutdown = vi.fn();
    app = await createApiServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        mode: "browser-serve",
        webOrigins: ["http://127.0.0.1:4200"],
        enableMutations: true,
        sessionToken: token
      },
      onePassword: service,
      lifecycle: {
        shutdown: {
          enabled: true,
          onShutdown
        }
      },
      logger: false
    });

    const startResponse = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { "x-session-token": token },
      payload: { mode: "live", accountName: "example-account" }
    });
    const shutdownResponse = await app.inject({
      method: "POST",
      url: "/api/session/shutdown",
      headers: { "x-session-token": token }
    });

    expect(startResponse.statusCode).toBe(200);
    expect(shutdownResponse.statusCode).toBe(409);
    expect(shutdownResponse.json().message).toContain("扫描或执行任务运行中");
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it("blocks execution when the decision omits items from the duplicate group", async () => {
    const scan = await scanAndAnalyze(app, { mode: "mock" });
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
    const scan = await scanAndAnalyze(app, { mode: "mock" });
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
    const scan = await scanAndAnalyze(app, { mode: "mock" });
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
    const scan = await scanAndAnalyze(app, { mode: "mock" });
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

  it("marks a duplicate group as skipped without removing it from the current scan", async () => {
    const scan = await scanAndAnalyze(app, { mode: "mock" });
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
    expect(response.json().scan.groups).toHaveLength(scan.groups.length);
    expect(response.json().scan.skippedGroupIds).toEqual([group.id]);

    const planResponse = await app.inject({
      method: "POST",
      url: "/api/plan",
      headers: { "x-session-token": token },
      payload: {
        scanId: scan.scanId,
        groupId: group.id,
        items: group.itemIds.map((itemId: string, index: number) => ({ itemId, keep: index === 0 }))
      }
    });

    expect(planResponse.statusCode).toBe(400);
    expect(planResponse.json().message).toContain("已标记跳过");

    const cachedAnalysis = await app.inject({
      method: "GET",
      url: "/api/analysis",
      headers: { "x-session-token": token }
    });

    expect(cachedAnalysis.statusCode).toBe(200);
    expect(cachedAnalysis.json().skippedGroupIds).toEqual([group.id]);
    expect(service.scan).not.toHaveBeenCalled();
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("shares scan cache globally while keeping analysis state isolated per tab", async () => {
    const start = await startScan(app, { mode: "mock" });
    const snapshot = await waitForScan(app, start.scanId);
    const tabA = { "x-session-token": token, "x-tab-id": "tab-a" };
    const tabB = { "x-session-token": token, "x-tab-id": "tab-b" };

    const scanFromTabB = await app.inject({
      method: "GET",
      url: "/api/scan",
      headers: tabB
    });
    const analyzeTabA = await app.inject({
      method: "POST",
      url: "/api/analyze",
      headers: tabA,
      payload: { scanId: snapshot.scanId }
    });
    const analysisTabBBeforeAnalyze = await app.inject({
      method: "GET",
      url: "/api/analysis",
      headers: tabB
    });
    const analyzeTabB = await app.inject({
      method: "POST",
      url: "/api/analyze",
      headers: tabB,
      payload: { scanId: snapshot.scanId }
    });
    const group = analyzeTabA.json().groups[0];
    const skipTabA = await app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/skip`,
      headers: tabA,
      payload: { scanId: snapshot.scanId }
    });
    const analysisTabBAfterSkip = await app.inject({
      method: "GET",
      url: "/api/analysis",
      headers: tabB
    });

    expect(scanFromTabB.statusCode).toBe(200);
    expect(scanFromTabB.json().scanId).toBe(snapshot.scanId);
    expect(analyzeTabA.statusCode).toBe(200);
    expect(analysisTabBBeforeAnalyze.statusCode).toBe(400);
    expect(analysisTabBBeforeAnalyze.json().message).toContain("还没有分析结果");
    expect(analyzeTabB.statusCode).toBe(200);
    expect(skipTabA.statusCode).toBe(200);
    expect(skipTabA.json().scan.groups).toHaveLength(analyzeTabA.json().groups.length);
    expect(skipTabA.json().scan.skippedGroupIds).toEqual([group.id]);
    expect(analysisTabBAfterSkip.statusCode).toBe(200);
    expect(analysisTabBAfterSkip.json().groups).toHaveLength(analyzeTabB.json().groups.length);
    expect(analysisTabBAfterSkip.json().groups[0].id).toBe(group.id);
    expect(analysisTabBAfterSkip.json().skippedGroupIds).toEqual([]);
  });

  it("restores a specific skipped duplicate group without calling 1Password", async () => {
    const scan = await scanAndAnalyze(app, { mode: "mock" });
    const group = scan.groups[0];

    await app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/skip`,
      headers: { "x-session-token": token },
      payload: { scanId: scan.scanId }
    });
    const restoreResponse = await app.inject({
      method: "POST",
      url: `/api/groups/${group.id}/restore`,
      headers: { "x-session-token": token },
      payload: { scanId: scan.scanId }
    });

    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().skippedGroupId).toBe(group.id);
    expect(restoreResponse.json().restorableSkippedGroupCount).toBe(0);
    expect(restoreResponse.json().scan.groups).toHaveLength(scan.groups.length);
    expect(restoreResponse.json().scan.skippedGroupIds).toEqual([]);
    expect(service.scan).not.toHaveBeenCalled();
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("reports when no skipped group can be restored", async () => {
    const scan = await scanAndAnalyze(app, { mode: "mock" });

    const response = await app.inject({
      method: "POST",
      url: "/api/groups/restore-skipped",
      headers: { "x-session-token": token },
      payload: { scanId: scan.scanId }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("没有可恢复");
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("keeps skipped-group state after completing a different mock group", async () => {
    const scan = await scanAndAnalyze(app, { mode: "mock" });
    const skippedGroup = scan.groups[0];
    const skipResponse = await app.inject({
      method: "POST",
      url: `/api/groups/${skippedGroup.id}/skip`,
      headers: { "x-session-token": token },
      payload: { scanId: scan.scanId }
    });
    const currentScan = skipResponse.json().scan;
    const group = currentScan.groups.find((candidate: { id: string }) => candidate.id !== skippedGroup.id);

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
      url: `/api/groups/${skippedGroup.id}/restore`,
      headers: { "x-session-token": token },
      payload: { scanId: currentScan.scanId }
    });

    expect(skipResponse.statusCode).toBe(200);
    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json().completedGroupId).toBe(group.id);
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().skippedGroupId).toBe(skippedGroup.id);
    expect(service.scan).not.toHaveBeenCalled();
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("allows live dry-run for permanent-delete plans without mutating items", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
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
    const firstScan = await scanAndAnalyze(app, { mode: "mock" });
    const group = firstScan.groups[0];

    const secondScan = await scanAndAnalyze(app, { mode: "mock" });
    expect(secondScan.scanId).not.toBe(firstScan.scanId);

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
    expect(planResponse.json().message).toContain("已过期");
    expect(executeResponse.json().message).toContain("已过期");
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
  });

  it("blocks live execution until the current plan has a successful dry-run", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
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
    expect(response.json().error).toContain("试运行");
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("treats live execution as dry-run unless mutations are explicitly enabled", async () => {
    await app.close();
    service = createService();
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    app = await createApiServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        webOrigins: ["http://127.0.0.1:4200"],
        enableMutations: false,
        sessionToken: token
      },
      onePassword: service,
      logger: false
    });

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
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
    expect(response.json().dryRun).toBe(true);
    expect(response.json().dryRunKey).toEqual(expect.any(String));
    expect(response.json().results.every((result: { dryRun?: boolean }) => result.dryRun)).toBe(true);
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("normalizes live action order before dry-run approval and execution", async () => {
    vi.mocked(service.scan).mockResolvedValue(createThreeItemScanResult());
    vi.mocked(service.archive).mockResolvedValue(undefined);
    vi.mocked(service.delete).mockResolvedValue(undefined);

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
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

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
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

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
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
    mockArchiveGroupVerification(service, scan, group);

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
    expect(secondExecute.json().error).toContain("已有执行任务正在运行");
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

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
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
    expect(rescanResponse.json().message).toContain("已有执行任务正在运行");
    expect(service.scan).toHaveBeenCalledTimes(1);

    releaseArchive();
    await firstExecute;
  });

  it("keeps the live scan usable after a group is completed successfully", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    vi.mocked(service.archive).mockResolvedValue(undefined);

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
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
    mockArchiveGroupVerification(service, scan, group);

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
    expect(completedGroupPlanResponse.json().message).toContain("找不到重复组");
    expect(nextGroupPlanResponse.statusCode).toBe(200);
  });

  it("keeps skipped-group state after completing a different live group", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    vi.mocked(service.archive).mockResolvedValue(undefined);

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
    const skippedGroup = scan.groups[0];
    const skipResponse = await app.inject({
      method: "POST",
      url: `/api/groups/${skippedGroup.id}/skip`,
      headers: { "x-session-token": token },
      payload: { scanId: scan.scanId }
    });
    const currentScan = skipResponse.json().scan;
    const group = currentScan.groups.find((candidate: { id: string }) => candidate.id !== skippedGroup.id);
    const payload = {
      scanId: currentScan.scanId,
      groupId: group.id,
      items: group.itemIds.map((itemId: string, index: number) => ({
        itemId,
        keep: index === 0
      }))
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);
    mockArchiveGroupVerification(service, currentScan, group);

    const executeResponse = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });
    const restoreResponse = await app.inject({
      method: "POST",
      url: `/api/groups/${skippedGroup.id}/restore`,
      headers: { "x-session-token": token },
      payload: { scanId: currentScan.scanId }
    });

    expect(skipResponse.statusCode).toBe(200);
    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json().scanInvalidated).toBe(false);
    expect(executeResponse.json().completedGroupId).toBe(group.id);
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().skippedGroupId).toBe(skippedGroup.id);
    expect(service.archive).toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(service.copyToVaultAndArchiveSource).not.toHaveBeenCalled();
  });

  it("verifies archived items after a successful live archive", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    vi.mocked(service.archive).mockResolvedValue(undefined);

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
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
    mockArchiveGroupVerification(service, scan, group);

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().scanInvalidated).toBe(false);
    expect(response.json().verification).toMatchObject({ ok: true, results: [] });
  });

  it("verifies deleted items are absent from active and archived states", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    vi.mocked(service.delete).mockResolvedValue(undefined);

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
    const group = scan.groups[0];
    const keepItem = scan.items.find((item) => item.id === group.itemIds[0])!;
    const deleteItem = scan.items.find((item) => item.id === group.itemIds[1])!;
    const payload = {
      scanId: scan.scanId,
      groupId: group.id,
      confirmPermanentDelete: true,
      permanentDeleteConfirmationPhrase: "永久删除",
      items: [
        { itemId: keepItem.id, keep: true },
        { itemId: deleteItem.id, keep: false, deleteMode: "delete" }
      ]
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);
    mockVaultStateReadSequence(service, [
      { [keepItem.vaultId]: { activeIds: [keepItem.onePasswordItemId], archivedIds: [] } },
      { [deleteItem.vaultId]: { activeIds: [deleteItem.onePasswordItemId], archivedIds: [] } },
      { [keepItem.vaultId]: { activeIds: [keepItem.onePasswordItemId], archivedIds: [] } },
      { [deleteItem.vaultId]: { activeIds: [], archivedIds: [] } }
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().scanInvalidated).toBe(false);
    expect(response.json().verification).toMatchObject({ ok: true, results: [] });
    expect(service.delete).toHaveBeenCalledWith(deleteItem.vaultId, deleteItem.onePasswordItemId);
  });

  it("invalidates the scan when a kept item disappears after execution", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    vi.mocked(service.archive).mockResolvedValue(undefined);

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
    const group = scan.groups[0];
    const keepItem = scan.items.find((item) => item.id === group.itemIds[0])!;
    const archiveItem = scan.items.find((item) => item.id === group.itemIds[1])!;
    const payload = {
      scanId: scan.scanId,
      groupId: group.id,
      items: [
        { itemId: keepItem.id, keep: true },
        { itemId: archiveItem.id, keep: false, deleteMode: "archive" }
      ]
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);
    mockVaultStateReadSequence(service, [
      { [keepItem.vaultId]: { activeIds: [keepItem.onePasswordItemId], archivedIds: [] } },
      { [archiveItem.vaultId]: { activeIds: [archiveItem.onePasswordItemId], archivedIds: [] } },
      { [keepItem.vaultId]: { activeIds: [], archivedIds: [] } },
      { [archiveItem.vaultId]: { activeIds: [], archivedIds: [archiveItem.onePasswordItemId] } }
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.scanInvalidated).toBe(true);
    expect(body.completedGroupId).toBeUndefined();
    expect(body.verification.ok).toBe(false);
    expect(body.verification.results).toContainEqual(expect.objectContaining({
      action: "keep",
      severity: "critical",
      ok: false
    }));
  });

  it("verifies moved items by checking source archive and target active item", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    vi.mocked(service.archive).mockResolvedValue(undefined);
    vi.mocked(service.copyToVaultAndArchiveSource).mockResolvedValue({ createdItemId: "created-copy-1" });

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
    const group = scan.groups[0];
    const moveItem = scan.items.find((item) => item.id === group.itemIds[0])!;
    const archiveItem = scan.items.find((item) => item.id === group.itemIds[1])!;
    const payload = {
      scanId: scan.scanId,
      groupId: group.id,
      items: [
        { itemId: moveItem.id, keep: true, targetVaultId: "vault-archive" },
        { itemId: archiveItem.id, keep: false, deleteMode: "archive" }
      ]
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);
    mockVaultStateReadSequence(service, [
      { "vault-archive": { activeIds: [], archivedIds: [] } },
      { [moveItem.vaultId]: { activeIds: [moveItem.onePasswordItemId], archivedIds: [] } },
      { [archiveItem.vaultId]: { activeIds: [archiveItem.onePasswordItemId], archivedIds: [] } },
      { "vault-archive": { activeIds: ["created-copy-1"], archivedIds: [] } },
      { [moveItem.vaultId]: { activeIds: [], archivedIds: [moveItem.onePasswordItemId] } },
      { [archiveItem.vaultId]: { activeIds: [], archivedIds: [archiveItem.onePasswordItemId] } }
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().scanInvalidated).toBe(false);
    expect(response.json().verification).toMatchObject({ ok: true, results: [] });
    expect(response.json().results).toContainEqual(expect.objectContaining({
      itemId: moveItem.id,
      action: "copy-to-vault-and-archive-source",
      createdItemId: "created-copy-1"
    }));
  });

  it("reports critical verification failure for unexpected vault state changes", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    vi.mocked(service.archive).mockResolvedValue(undefined);

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
    const group = scan.groups[0];
    const keepItem = scan.items.find((item) => item.id === group.itemIds[0])!;
    const archiveItem = scan.items.find((item) => item.id === group.itemIds[1])!;
    const payload = {
      scanId: scan.scanId,
      groupId: group.id,
      items: [
        { itemId: keepItem.id, keep: true },
        { itemId: archiveItem.id, keep: false, deleteMode: "archive" }
      ]
    };
    const confirmedDryRunKey = await dryRunGroup(app, payload);
    mockVaultStateReadSequence(service, [
      { [keepItem.vaultId]: { activeIds: [keepItem.onePasswordItemId], archivedIds: [] } },
      { [archiveItem.vaultId]: { activeIds: [archiveItem.onePasswordItemId, "external-item"], archivedIds: [] } },
      { [keepItem.vaultId]: { activeIds: [keepItem.onePasswordItemId], archivedIds: [] } },
      { [archiveItem.vaultId]: { activeIds: [], archivedIds: [archiveItem.onePasswordItemId, "external-item"] } }
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "x-session-token": token },
      payload: { ...payload, confirmedDryRunKey }
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.scanInvalidated).toBe(true);
    expect(body.verification.ok).toBe(false);
    expect(body.verification.results).toContainEqual(expect.objectContaining({
      itemId: "external-item",
      severity: "critical",
      ok: false
    }));
  });

  it("invalidates live scan state after a failed mutation", async () => {
    vi.mocked(service.scan).mockResolvedValue(createMockScanResult());
    vi.mocked(service.archive).mockRejectedValue(new Error("archive failed"));

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
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
    expect(planAfterFailureResponse.json().message).toContain("请先完成扫描并手动运行分析");
  });

  it("stops live execution after the first failed mutation", async () => {
    vi.mocked(service.scan).mockResolvedValue(createThreeItemScanResult());
    vi.mocked(service.archive).mockRejectedValue(new Error("archive failed"));

    const scan = await scanAndAnalyze(app, { mode: "live", accountName: "example-account" });
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
