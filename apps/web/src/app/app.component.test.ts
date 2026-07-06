import "@angular/compiler";
import { signal } from "@angular/core";
import {
  createExecutionPlan,
  findDuplicateGroups,
  GroupDecision,
  ItemSummary,
  RevealCredentialsResponse,
  ScanProgress,
  ScanProgressEvent,
  ScanResult,
  ScanSnapshot,
  summarizeVaults
} from "@optimize-password/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiService } from "./api.service";
import { AppComponent } from "./app.component";

interface SessionState {
  token: string;
  accountName?: string;
  apiBaseUrl: string;
  enableMutations: boolean;
  forceDryRun: boolean;
  hasServiceAccountToken: boolean;
  supportsDesktopAuth: boolean;
}

class MockApiService {
  readonly session = signal<SessionState | undefined>({
    token: "test-token",
    apiBaseUrl: "http://127.0.0.1:3417",
    enableMutations: false,
    forceDryRun: true,
    hasServiceAccountToken: false,
    supportsDesktopAuth: true
  });

  private scanState = createScanFixture();
  private readonly skippedGroups: ScanResult["groups"] = [];

  readonly loadSession = vi.fn(async () => this.session()!);
  readonly startScan = vi.fn(async (options: { accountName?: string; mode?: "live" | "mock" }) => {
    this.scanState = createScanFixture();
    this.skippedGroups.length = 0;
    return {
      scanId: this.scanState.scanId,
      mode: options.mode ?? "live",
      progress: scanProgressFor(this.scanState, "scanning", [])
    };
  });
  readonly streamScanEvents = vi.fn(async (_scanId: string, onEvent: (event: ScanProgressEvent) => void) => {
    onEvent({ type: "started", progress: scanProgressFor(this.scanState, "scanning", []) });
    onEvent({
      type: "completed",
      progress: scanProgressFor(this.scanState, "completed", this.scanState.items),
      scan: scanSnapshotFor(this.scanState)
    });
  });
  readonly loadScan = vi.fn(async () => scanSnapshotFor(this.scanState));
  readonly analyze = vi.fn(async () => this.scanState);
  readonly revealCredentials = vi.fn(async (scanId: string, itemId: string): Promise<RevealCredentialsResponse> => ({
    scanId,
    itemId,
    expiresInSeconds: 30,
    fields: [
      {
        label: "password",
        value: `secret-for-${itemId}`,
        fieldType: "concealed"
      }
    ]
  }));
  readonly createPlan = vi.fn(async (decision: GroupDecision) =>
    createExecutionPlan(decision.groupId, decision, this.scanState.items)
  );
  readonly execute = vi.fn(async (decision: GroupDecision & { dryRun?: boolean }) => {
    const plan = createExecutionPlan(decision.groupId, decision, this.scanState.items);
    const results = plan.actions.map((action) => ({
      itemId: action.itemId,
      action: action.type,
      ok: true,
      dryRun: Boolean(decision.dryRun)
    }));

    if (decision.dryRun) {
      return {
        plan,
        results,
        dryRun: true,
        dryRunKey: "approved-dry-run-key"
      };
    }

    this.scanState = removeGroup(this.scanState, decision.groupId);
    this.skippedGroups.length = 0;
    return {
      plan,
      results,
      completedGroupId: decision.groupId,
      scan: this.scanState,
      scanInvalidated: false
    };
  });
  readonly skipGroup = vi.fn(async (scanId: string, groupId: string) => {
    const group = this.scanState.groups.find((candidate) => candidate.id === groupId);
    if (!group) {
      throw new Error(`Unknown group: ${groupId}`);
    }
    this.skippedGroups.push(group);
    this.scanState = removeGroup(this.scanState, groupId);
    return {
      skippedGroupId: groupId,
      restorableSkippedGroupCount: this.skippedGroups.length,
      scan: this.scanState
    };
  });
  readonly restoreSkippedGroup = vi.fn(async () => {
    const restoredGroup = this.skippedGroups.pop();
    if (!restoredGroup) {
      throw new Error("No skipped group");
    }
    this.scanState = {
      ...this.scanState,
      groups: [restoredGroup, ...this.scanState.groups]
    };
    return {
      restoredGroupId: restoredGroup.id,
      restorableSkippedGroupCount: this.skippedGroups.length,
      scan: this.scanState
    };
  });
  readonly clearScan = vi.fn(async () => ({ ok: true }));
}

describe("AppComponent interaction state", () => {
  let api: MockApiService;
  let component: AppComponent;
  let browserLocation: { origin: string; pathname: string };
  let popstateHandler: (() => void) | undefined;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    browserLocation = { origin: "http://127.0.0.1:4200", pathname: "/" };
    popstateHandler = undefined;
    vi.stubGlobal("window", {
      location: browserLocation,
      history: {
        pushState: vi.fn((_state: unknown, _title: string, url?: string | URL | null) => {
          browserLocation.pathname = url ? String(url) : browserLocation.pathname;
        })
      },
      addEventListener: vi.fn((event: string, handler: EventListenerOrEventListenerObject) => {
        if (event === "popstate" && typeof handler === "function") {
          popstateHandler = handler as () => void;
        }
      }),
      removeEventListener: vi.fn(),
      confirm: vi.fn(() => true),
      prompt: vi.fn()
    });
    vi.stubGlobal("localStorage", createMemoryStorage());

    api = new MockApiService();
    component = new AppComponent(api as unknown as ApiService);
    component.scanMode.set("mock");
  });

  it("pushes workspace route on scan and follows browser history", async () => {
    expect(component.workspaceActive()).toBe(false);

    await component.scan();

    expect(window.history.pushState).toHaveBeenCalledWith({ page: "workspace" }, "", "/workspace");
    expect(component.workspaceActive()).toBe(true);
    expect(component.scanSnapshot()?.items).toHaveLength(4);

    browserLocation.pathname = "/";
    popstateHandler?.();

    expect(component.workspaceActive()).toBe(false);

    browserLocation.pathname = "/workspace";
    popstateHandler?.();

    expect(component.workspaceActive()).toBe(true);
    expect(component.scanSnapshot()?.items).toHaveLength(4);
  });

  it("initializes a mock scan with recommended keep decisions and group filters", async () => {
    await component.scan();

    expect(api.startScan).toHaveBeenCalledWith({ accountName: "", mode: "mock" });
    expect(api.streamScanEvents).toHaveBeenCalled();
    expect(component.scanSnapshot()?.items).toHaveLength(4);
    expect(component.scanResult()).toBeUndefined();
    expect(component.groups()).toHaveLength(0);

    await component.analyze();

    expect(api.analyze).toHaveBeenCalledWith("scan-web-test");
    expect(component.scanResult()?.groups).toHaveLength(2);
    expect(component.activeCandidateTab()).toBe("similar-login");
    expect(component.groups()).toHaveLength(1);
    expect(component.selectedItems()).toHaveLength(2);
    expect(component.decisionSummary().keep).toBe(1);
    expect(component.decisionSummary().archive).toBe(1);

    component.updateTraitFilter("cross-vault");
    expect(component.groups().every((group) => component.groupBadges(group).includes("跨保险库"))).toBe(true);

    component.setCandidateTab("misc");
    expect(component.groups()).toHaveLength(1);
  });

  it("blocks live scans without a Desktop App account identifier", async () => {
    component.scanMode.set("live");

    await component.scan();

    expect(api.startScan).not.toHaveBeenCalled();
    expect(component.error()).toContain("真实扫描需要填写 Desktop App 账户标识");
  });

  it("keeps partial vault progress visible when a scan fails", async () => {
    const failedProgress: ScanProgress = {
      scanId: "scan-web-test",
      phase: "failed",
      totalVaults: 2,
      scannedVaults: 0,
      totalItems: 0,
      scannedItems: 0,
      vaults: summarizeVaults(
        [
          { id: "vault-personal", name: "Personal" },
          { id: "vault-work", name: "Work" }
        ],
        []
      ),
      message: "已发现 2 个保险库，但无法读取任何项目列表。",
      error: "1Password 扫描失败：Unexpected error when retrieving response contents"
    };
    api.streamScanEvents.mockImplementationOnce(async (_scanId, onEvent) => {
      onEvent({
        type: "failed",
        progress: failedProgress,
        error: failedProgress.error
      });
    });

    await component.scan();

    expect(component.workspaceActive()).toBe(true);
    expect(component.scanFailed()).toBe(true);
    expect(component.scanComplete()).toBe(false);
    expect(component.vaults().map((vault) => vault.name)).toEqual(["Personal", "Work"]);
    expect(component.analysisEmptyTitle()).toBe("扫描中断");
    expect(component.error()).toContain("1Password 扫描失败");

    await component.analyze();

    expect(api.analyze).not.toHaveBeenCalled();
    expect(component.error()).toBe("请先完成扫描，再运行分析。");
  });

  it("loads and persists the Desktop App account identifier locally", async () => {
    const storage = createMemoryStorage({ "optipass.desktopAccountName": "StoredAccount" });
    vi.stubGlobal("localStorage", storage);

    await component.ngOnInit();

    expect(component.accountName()).toBe("StoredAccount");

    component.updateAccountName("  BppleMan  ");

    expect(storage.getItem("optipass.desktopAccountName")).toBe("BppleMan");

    component.updateAccountName(" ");

    expect(storage.getItem("optipass.desktopAccountName")).toBeNull();
  });

  it("skips and restores the selected duplicate group without changing decisions for kept items", async () => {
    await component.scan();
    await component.analyze();
    const skippedGroupId = component.selectedGroupId();
    const keptItemId = component.selectedItems().find((item) => component.decisionFor(item).keep)?.id;

    await component.skipSelectedGroup();

    expect(api.skipGroup).toHaveBeenCalledWith(component.scanResult()?.scanId, skippedGroupId);
    expect(component.scanResult()?.groups).toHaveLength(1);
    expect(component.restorableSkippedGroupCount()).toBe(1);
    expect(component.selectedGroupId()).not.toBe(skippedGroupId);

    await component.restoreLastSkippedGroup();

    expect(api.restoreSkippedGroup).toHaveBeenCalled();
    expect(component.scanResult()?.groups).toHaveLength(2);
    expect(component.selectedGroupId()).toBe(skippedGroupId);
    expect(component.restorableSkippedGroupCount()).toBe(0);
    expect(component.decisions()[keptItemId!].keep).toBe(true);
  });

  it("records successful live preview approval and clears it when the decision changes", async () => {
    api.session.set({
      token: "test-token",
      apiBaseUrl: "http://127.0.0.1:3417",
      enableMutations: true,
      forceDryRun: false,
      hasServiceAccountToken: false,
      supportsDesktopAuth: true
    });
    component.scanMode.set("live");
    component.accountName.set("BppleMan");
    await component.scan();
    await component.analyze();

    await component.previewPlan();

    expect(api.createPlan).toHaveBeenCalled();
    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(component.approvedDryRunKey()).toBe("approved-dry-run-key");
    expect(component.canExecutePlan()).toBe(true);

    const item = component.selectedItems()[0];
    component.updateKeep(item, !component.decisionFor(item).keep);

    expect(component.approvedDryRunKey()).toBeUndefined();
    expect(component.canExecutePlan()).toBe(false);
  });

  it("executes a mock plan, advances the selected group, and clears restore state", async () => {
    await component.scan();
    await component.analyze();
    const completedGroupId = component.selectedGroupId();

    await component.skipSelectedGroup();
    expect(component.restorableSkippedGroupCount()).toBe(1);
    await component.restoreLastSkippedGroup();
    expect(component.restorableSkippedGroupCount()).toBe(0);

    await component.previewPlan();
    expect(component.plan()?.groupId).toBe(completedGroupId);

    await component.executePlan();

    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ groupId: completedGroupId }));
    expect(component.scanResult()?.groups).toHaveLength(1);
    expect(component.completedGroupCount()).toBe(1);
    expect(component.selectedGroupId()).not.toBe(completedGroupId);
    expect(component.plan()).toBeUndefined();
    expect(component.executeResult()).toBeUndefined();
    expect(component.restorableSkippedGroupCount()).toBe(0);
    expect(component.status()).toContain("已完成 1 个重复组");
  });

  it("reveals credential material temporarily on demand", async () => {
    await component.scan();
    await component.analyze();
    const item = component.selectedItems()[0];

    expect(component.credentialMaterialDisplay(item)).toBe("••••••••");

    await component.toggleCredentialReveal(item);

    expect(api.revealCredentials).toHaveBeenCalledWith("scan-web-test", item.id);
    expect(component.credentialMaterialDisplay(item)).toBe(`secret-for-${item.id}`);

    await component.toggleCredentialReveal(item);

    expect(component.credentialMaterialDisplay(item)).toBe("••••••••");
  });
});

function createScanFixture(): ScanResult {
  const items = [
    item({
      id: "vault-personal:github-1",
      onePasswordItemId: "github-1",
      vaultId: "vault-personal",
      vaultName: "Personal",
      title: "GitHub",
      urls: ["https://github.com/login"],
      usernames: ["alice@example.com"],
      tags: ["dev"],
      fieldCount: 5,
      hasTotp: true,
      hasNotes: true,
      comparableFields: [
        { label: "username", kind: "username", normalizedValue: "alice@example.com" },
        { label: "password", kind: "secret", normalizedValueHash: "github-work-secret" }
      ]
    }),
    item({
      id: "vault-work:github-2",
      onePasswordItemId: "github-2",
      vaultId: "vault-work",
      vaultName: "Work",
      title: "github copy",
      urls: ["github.com/login"],
      usernames: ["alice@example.com"],
      tags: ["imported"],
      fieldCount: 3,
      comparableFields: [
        { label: "username", kind: "username", normalizedValue: "alice@example.com" },
        { label: "password", kind: "secret", normalizedValueHash: "github-secret" }
      ]
    }),
    item({
      id: "vault-personal:aws-1",
      onePasswordItemId: "aws-1",
      vaultId: "vault-personal",
      vaultName: "Personal",
      title: "AWS root",
      category: "api-credential",
      urls: ["https://console.aws.amazon.com"],
      usernames: ["ops@example.com"],
      tags: ["cloud"],
      fieldCount: 6,
      hasTotp: true,
      hasAttachments: true,
      hasNotes: true,
      comparableFields: [
        { label: "access key", kind: "text", normalizedValue: "AKIA-MOCK-KEY" },
        { label: "secret key", kind: "secret", normalizedValueHash: "aws-secret" }
      ]
    }),
    item({
      id: "vault-archive:aws-2",
      onePasswordItemId: "aws-2",
      vaultId: "vault-archive",
      vaultName: "Archive",
      title: "AWS root",
      category: "api-credential",
      urls: ["https://console.aws.amazon.com"],
      usernames: ["ops@example.com"],
      tags: ["old"],
      fieldCount: 3,
      comparableFields: [
        { label: "access key", kind: "text", normalizedValue: "AKIA-MOCK-KEY" },
        { label: "secret key", kind: "secret", normalizedValueHash: "aws-secret" }
      ]
    })
  ];

  return {
    scanId: "scan-web-test",
    scannedAt: "2026-06-28T00:00:00.000Z",
    analyzedAt: "2026-06-28T00:00:01.000Z",
    vaults: [
      { id: "vault-personal", name: "Personal" },
      { id: "vault-work", name: "Work" },
      { id: "vault-archive", name: "Archive" }
    ],
    items,
    groups: [
      ...findDuplicateGroups(items),
      {
        id: "misc-title:vault-personal:aws-1:vault-archive:aws-2",
        candidateClass: "misc-title",
        itemIds: ["vault-personal:aws-1", "vault-archive:aws-2"],
        reasons: [
          {
            rule: "title",
            key: "misc-title:aws-root",
            label: "标题相同：AWS root",
            itemIds: ["vault-personal:aws-1", "vault-archive:aws-2"]
          }
        ],
        recommendedKeepIds: ["vault-personal:aws-1"],
        recommendedKeepReasons: [
          {
            itemId: "vault-personal:aws-1",
            score: 30,
            labels: ["字段更多", "有一次性密码"]
          }
        ],
        confidence: "medium"
      }
    ]
  };
}

function scanSnapshotFor(scan: ScanResult): ScanSnapshot {
  return {
    scanId: scan.scanId,
    scannedAt: scan.scannedAt,
    vaults: scan.vaults,
    items: scan.items
  };
}

function scanProgressFor(scan: ScanResult, phase: ScanProgress["phase"], items: ItemSummary[]): ScanProgress {
  return {
    scanId: scan.scanId,
    phase,
    totalVaults: scan.vaults.length,
    scannedVaults: phase === "completed" ? scan.vaults.length : 0,
    totalItems: scan.items.length,
    scannedItems: items.length,
    vaults: summarizeVaults(scan.vaults, items),
    message: phase === "completed" ? "扫描完成，等待手动分析。" : "正在读取 1Password 数据。"
  };
}

function item(overrides: Partial<ItemSummary> & Pick<ItemSummary, "id" | "title">): ItemSummary {
  return {
    onePasswordItemId: overrides.id,
    vaultId: "vault-personal",
    vaultName: "Personal",
    category: "login",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    urls: [],
    usernames: [],
    tags: [],
    fieldCount: 2,
    hasPassword: false,
    hasTotp: false,
    hasPasskey: false,
    hasAttachments: false,
    hasNotes: false,
    comparableFields: [],
    ...overrides
  };
}

function removeGroup(scan: ScanResult, groupId: string): ScanResult {
  return {
    ...scan,
    groups: scan.groups.filter((group) => group.id !== groupId)
  };
}

function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    })
  };
}
