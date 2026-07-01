import { CommonModule } from "@angular/common";
import { Component, computed, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import {
  DashboardCategory,
  dashboardCategoryFor,
  dashboardCategoryDefinitions,
  DuplicateGroup,
  DuplicateRule,
  ExecutionPlan,
  GroupDecision,
  ItemCategory,
  ItemDecision,
  ItemSummary,
  PlanAction,
  RevealCredentialsResponse,
  ScanProgress,
  ScanResult,
  ScanSnapshot
} from "@optimize-password/core";
import { ApiService } from "./api.service";

interface ExecuteResponse {
  plan?: ExecutionPlan;
  scan?: ScanResult;
  results?: ExecuteActionResult[];
  blocked?: boolean;
  error?: string;
  dryRun?: boolean;
  dryRunKey?: string;
  scanInvalidated?: boolean;
  completedGroupId?: string;
}

interface ExecuteActionResult {
  itemId: string;
  action: string;
  ok: boolean;
  dryRun?: boolean;
  skipped?: boolean;
  error?: string;
}

const permanentDeleteConfirmationPhrase = "永久删除";
const desktopAccountNameStorageKey = "optipass.desktopAccountName";
type GroupTraitFilter = "all" | "cross-vault" | "totp" | "passkey" | "attachments";
type CandidateTab = "similar-login" | "exact" | "delete-suggestion" | "misc";
type RuleFilter = "all" | DuplicateRule;

interface CandidateTabView {
  id: CandidateTab;
  label: string;
  count: number;
}

interface WorkflowStep {
  index: number;
  label: string;
  status: "done" | "current" | "upcoming";
}

interface VaultProgressView {
  id: string;
  name: string;
  count: number;
}

interface CategoryDistributionView {
  category: DashboardCategory;
  label: string;
  count: number;
  icon: string;
}

interface RevealedCredentialView {
  fields: RevealCredentialsResponse["fields"];
  expiresAt: number;
}

interface GroupOverview {
  total: number;
  visible: number;
  high: number;
  medium: number;
  low: number;
  crossVault: number;
  totp: number;
  passkey: number;
  attachments: number;
}

const itemCategoryCatalog: Array<{ category: ItemCategory; label: string; icon: string }> = [
  { category: "login", label: "登录项", icon: "登" },
  { category: "password", label: "密码", icon: "密" },
  { category: "api-credential", label: "API 凭据", icon: "API" },
  { category: "ssh-key", label: "SSH 密钥", icon: "SSH" },
  { category: "database", label: "数据库", icon: "库" },
  { category: "server", label: "服务器", icon: "服" },
  { category: "router", label: "路由器", icon: "路" },
  { category: "secure-note", label: "安全笔记", icon: "记" },
  { category: "document", label: "文档", icon: "文" },
  { category: "identity", label: "身份", icon: "份" },
  { category: "person", label: "人物", icon: "人" },
  { category: "email", label: "邮箱", icon: "邮" },
  { category: "credit-card", label: "信用卡", icon: "卡" },
  { category: "bank-account", label: "银行账户", icon: "银" },
  { category: "crypto-wallet", label: "加密钱包", icon: "链" },
  { category: "software-license", label: "软件许可证", icon: "软" },
  { category: "membership", label: "会员", icon: "会" },
  { category: "rewards", label: "奖励", icon: "奖" },
  { category: "passport", label: "护照", icon: "护" },
  { category: "driver-license", label: "驾照", icon: "驾" },
  { category: "outdoor-license", label: "户外许可证", icon: "户" },
  { category: "medical-record", label: "医疗记录", icon: "医" },
  { category: "social-security-number", label: "社安号", icon: "SSN" },
  { category: "unsupported", label: "未支持类型", icon: "未" },
  { category: "unknown", label: "未知类型", icon: "?" }
];

const dashboardCategoryIcons: Record<DashboardCategory, string> = {
  login: "登",
  "secure-note": "记",
  "credit-card": "卡",
  document: "文",
  password: "密",
  "api-credential": "证",
  database: "库",
  "ssh-key": "钥",
  identity: "身",
  server: "服",
  "software-license": "软",
  other: "其"
};

@Component({
  selector: "op-root",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./app.component.html"
})
export class AppComponent implements OnInit {
  readonly scanSnapshot = signal<ScanSnapshot | undefined>(undefined);
  readonly scanProgress = signal<ScanProgress | undefined>(undefined);
  readonly scanResult = signal<ScanResult | undefined>(undefined);
  readonly selectedGroupId = signal<string | undefined>(undefined);
  readonly loading = signal(false);
  readonly analyzing = signal(false);
  readonly error = signal<string | undefined>(undefined);
  readonly status = signal<string | undefined>(undefined);
  readonly plan = signal<ExecutionPlan | undefined>(undefined);
  readonly executeResult = signal<ExecuteResponse | undefined>(undefined);
  readonly accountName = signal("");
  readonly scanMode = signal<"live" | "mock">("live");
  readonly activeScanMode = signal<"live" | "mock" | undefined>(undefined);
  readonly scanStale = signal(false);
  readonly initialGroupCount = signal(0);
  readonly restorableSkippedGroupCount = signal(0);
  readonly approvedDryRunKey = signal<string | undefined>(undefined);
  readonly groupQuery = signal("");
  readonly confidenceFilter = signal<"all" | "high" | "medium" | "low">("all");
  readonly ruleFilter = signal<RuleFilter>("all");
  readonly traitFilter = signal<GroupTraitFilter>("all");
  readonly vaultFilter = signal("all");
  readonly categoryFilter = signal("all");
  readonly groupSort = signal<"priority" | "size" | "confidence" | "rules">("priority");
  readonly activeCandidateTab = signal<CandidateTab>("similar-login");
  readonly activeVaultId = signal<string | undefined>(undefined);
  readonly vaultQuery = signal("");
  readonly decisions = signal<Record<string, ItemDecision>>({});
  readonly revealedCredentials = signal<Record<string, RevealedCredentialView>>({});
  readonly session = computed(() => this.api.session());
  readonly clientOrigin = typeof window === "undefined" ? "unknown" : window.location.origin;

  readonly scanData = computed(() => this.scanResult() ?? this.scanSnapshot());
  readonly workspaceActive = computed(() => this.loading() || this.analyzing() || Boolean(this.scanData()));
  readonly scanComplete = computed(() => this.scanProgress()?.phase === "completed" || Boolean(this.scanSnapshot()));
  readonly analysisReady = computed(() => Boolean(this.scanResult()));
  readonly groups = computed(() => this.filterAndSortGroups(this.scanResult()?.groups ?? []));
  readonly allGroups = computed(() => this.scanResult()?.groups ?? []);
  readonly groupOverview = computed(() => this.buildGroupOverview());
  readonly vaults = computed(() => this.scanData()?.vaults ?? []);
  readonly workflowStep = computed(() => {
    if (this.loading()) {
      return 2;
    }
    if (!this.scanData()) {
      return 1;
    }
    if (this.analyzing() || !this.scanResult()) {
      return 3;
    }
    if (this.plan() || this.executeResult()) {
      return 5;
    }
    return 4;
  });
  readonly workflowSteps = computed<WorkflowStep[]>(() => {
    const current = this.workflowStep();
    return ["连接", "读取数据", "分析候选", "人工解决", "应用方案"].map((label, index) => {
      const step = index + 1;
      return {
        index: step,
        label,
        status: step < current ? "done" : step === current ? "current" : "upcoming"
      };
    });
  });
  readonly candidateTabs = computed<CandidateTabView[]>(() => {
    const counts: Record<CandidateTab, number> = {
      "similar-login": 0,
      exact: 0,
      "delete-suggestion": 0,
      misc: 0
    };
    for (const group of this.allGroups()) {
      counts[this.candidateClassForGroup(group)] += 1;
    }
    return [
      { id: "similar-login", label: "疑似相似", count: counts["similar-login"] },
      { id: "exact", label: "全等重复", count: counts.exact },
      { id: "delete-suggestion", label: "可删除建议", count: counts["delete-suggestion"] },
      { id: "misc", label: "杂项组", count: counts.misc }
    ];
  });
  readonly vaultProgress = computed<VaultProgressView[]>(() => {
    const progress = this.scanProgress();
    if (progress?.vaults.length) {
      return progress.vaults.map((vault) => ({
        id: vault.id,
        name: vault.name,
        count: vault.itemCount
      }));
    }

    const data = this.scanData();
    if (!data) {
      return [];
    }
    const counts = new Map(data.vaults.map((vault) => [vault.id, 0]));
    for (const item of data.items) {
      counts.set(item.vaultId, (counts.get(item.vaultId) ?? 0) + 1);
    }
    return data.vaults.map((vault) => ({
      id: vault.id,
      name: vault.name,
      count: counts.get(vault.id) ?? 0
    }));
  });
  readonly filteredVaultProgress = computed<VaultProgressView[]>(() => {
    const query = this.vaultQuery().trim().toLowerCase();
    if (!query) {
      return this.vaultProgress();
    }
    return this.vaultProgress().filter((vault) => vault.name.toLowerCase().includes(query));
  });
  readonly activeVaultItemCount = computed(() => {
    const activeVaultId = this.activeVaultId();
    const progressVault = this.scanProgress()?.vaults.find((vault) => vault.id === activeVaultId);
    if (progressVault) {
      return progressVault.itemCount;
    }
    const data = this.scanData();
    if (!data || !activeVaultId) {
      return data?.items.length ?? 0;
    }
    return data.items.filter((item) => item.vaultId === activeVaultId).length;
  });
  readonly categoryDistribution = computed<CategoryDistributionView[]>(() => {
    const activeVaultId = this.activeVaultId();
    const progressVault = this.scanProgress()?.vaults.find((vault) => vault.id === activeVaultId);
    if (progressVault) {
      return dashboardCategoryDefinitions.map((definition) => ({
        category: definition.id,
        label: definition.label,
        icon: dashboardCategoryIcons[definition.id],
        count: progressVault.categoryCounts[definition.id] ?? 0
      }));
    }

    const data = this.scanData();
    if (!data) {
      return dashboardCategoryDefinitions.map((definition) => ({
        category: definition.id,
        label: definition.label,
        icon: dashboardCategoryIcons[definition.id],
        count: 0
      }));
    }
    const items = activeVaultId ? data.items.filter((item) => item.vaultId === activeVaultId) : data.items;
    const counts = new Map<DashboardCategory, number>();
    for (const item of items) {
      const category = dashboardCategoryFor(item.category);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return dashboardCategoryDefinitions.map(({ id, label }) => ({
      category: id,
      label,
      icon: dashboardCategoryIcons[id],
      count: counts.get(id) ?? 0
    }));
  });
  readonly categories = computed(() => {
    const data = this.scanData();
    if (!data) {
      return [];
    }
    return Array.from(new Set(data.items.map((item) => item.category))).sort();
  });
  readonly completedGroupCount = computed(() => Math.max(0, this.initialGroupCount() - this.allGroups().length));
  readonly currentPlanRequiresDryRun = computed(() => this.activeScanMode() === "live");
  readonly liveExecutionDisabled = computed(() => this.activeScanMode() === "live" && !this.session()?.enableMutations);
  readonly canExecutePlan = computed(() => {
    const plan = this.plan();
    if (!plan || plan.blockers.length > 0 || this.loading() || this.scanStale() || this.liveExecutionDisabled()) {
      return false;
    }
    return !this.currentPlanRequiresDryRun() || Boolean(this.approvedDryRunKey());
  });
  readonly selectedGroup = computed(() => this.groups().find((group) => group.id === this.selectedGroupId()));
  readonly selectedGroupIndex = computed(() => this.groups().findIndex((group) => group.id === this.selectedGroupId()));
  readonly hasPreviousGroup = computed(() => this.selectedGroupIndex() > 0);
  readonly hasNextGroup = computed(() => {
    const index = this.selectedGroupIndex();
    return index >= 0 && index < this.groups().length - 1;
  });
  readonly selectedItems = computed(() => {
    const result = this.scanResult();
    const group = this.selectedGroup();
    if (!result || !group) {
      return [];
    }
    const byId = new Map(result.items.map((item) => [item.id, item]));
    return group.itemIds.map((id) => byId.get(id)).filter((item): item is ItemSummary => Boolean(item));
  });
  readonly decisionSummary = computed(() => {
    const items = this.selectedItems();
    return items.reduce(
      (summary, item) => {
        const decision = this.decisionFor(item);
        if (decision.keep) {
          summary.keep += 1;
          if ((decision.targetVaultId || item.vaultId) !== item.vaultId) {
            summary.move += 1;
          }
        } else if (decision.deleteMode === "delete") {
          summary.delete += 1;
        } else {
          summary.archive += 1;
        }
        return summary;
      },
      { keep: 0, archive: 0, delete: 0, move: 0 }
    );
  });
  readonly executionSummary = computed(() => {
    const result = this.executeResult();
    const results = result?.results ?? [];
    return {
      total: results.length,
      ok: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok && !item.skipped).length,
      skipped: results.filter((item) => item.skipped).length,
      dryRun: Boolean(result?.dryRun || results.some((item) => item.dryRun)),
      blocked: Boolean(result?.blocked)
    };
  });

  constructor(private readonly api: ApiService) {}

  async ngOnInit(): Promise<void> {
    try {
      const session = await this.api.loadSession();
      this.accountName.set(this.readStoredAccountName() ?? session.accountName ?? "");
    } catch (error) {
      this.error.set(this.messageFor(error));
    }
  }

  updateAccountName(value: string): void {
    this.accountName.set(value);
    this.persistAccountName(value);
  }

  async scan(): Promise<void> {
    if (this.requiresDesktopAccountName()) {
      this.error.set("真实扫描需要填写 Desktop App 账户标识。它是 1Password 桌面 App 左上角显示的账户名或 account_uuid，不是密码或 token。");
      return;
    }

    this.loading.set(true);
    this.error.set(undefined);
    this.status.set(undefined);
    this.scanSnapshot.set(undefined);
    this.scanProgress.set(undefined);
    this.scanResult.set(undefined);
    this.plan.set(undefined);
    this.executeResult.set(undefined);
    this.approvedDryRunKey.set(undefined);
    this.scanStale.set(false);
    this.selectedGroupId.set(undefined);
    this.initialGroupCount.set(0);
    this.restorableSkippedGroupCount.set(0);
    this.decisions.set({});
    this.revealedCredentials.set({});
    try {
      const start = await this.api.startScan({ accountName: this.accountName().trim(), mode: this.scanMode() });
      this.activeScanMode.set(start.mode);
      this.scanProgress.set(start.progress);

      let completedScan: ScanSnapshot | undefined;
      await this.api.streamScanEvents(start.scanId, (event) => {
        this.scanProgress.set(event.progress);
        const firstProgressVault = event.progress.vaults[0]?.id;
        if (!this.activeVaultId() && firstProgressVault) {
          this.activeVaultId.set(firstProgressVault);
        }
        if (event.scan) {
          completedScan = event.scan;
          this.scanSnapshot.set(event.scan);
          this.activeVaultId.set(this.activeVaultId() ?? event.scan.vaults[0]?.id);
        }
        if (event.type === "failed") {
          this.error.set(event.error || event.progress.error || "扫描失败，请查看本地 API 日志。");
        }
      });

      if (!completedScan && this.scanProgress()?.phase === "completed") {
        completedScan = await this.api.loadScan();
        this.scanSnapshot.set(completedScan);
      }
      if (completedScan) {
        this.activeVaultId.set(this.activeVaultId() ?? completedScan.vaults[0]?.id);
        this.status.set("扫描完成。分析不会自动开始，请按需运行分析。");
      } else if (this.scanProgress()?.phase === "failed") {
        throw new Error(this.scanProgress()?.error || "扫描失败，请查看本地 API 日志。");
      }
    } catch (error) {
      this.error.set(this.messageFor(error));
    } finally {
      this.loading.set(false);
    }
  }

  async analyze(): Promise<void> {
    const scan = this.scanSnapshot() ?? this.scanResult();
    if (!scan) {
      this.error.set("请先完成扫描，再运行分析。");
      return;
    }

    this.analyzing.set(true);
    this.error.set(undefined);
    this.status.set(undefined);
    this.plan.set(undefined);
    this.executeResult.set(undefined);
    this.approvedDryRunKey.set(undefined);
    this.scanStale.set(false);
    this.revealedCredentials.set({});
    try {
      const result = await this.api.analyze(scan.scanId);
      this.scanResult.set(result);
      this.scanSnapshot.set({
        scanId: result.scanId,
        scannedAt: result.scannedAt,
        vaults: result.vaults,
        items: result.items
      });
      this.initialGroupCount.set(result.groups.length);
      this.restorableSkippedGroupCount.set(0);
      this.activeCandidateTab.set(this.firstAvailableCandidateTab(result));
      this.activeVaultId.set(this.activeVaultId() ?? result.vaults[0]?.id);
      this.selectedGroupId.set(this.filterAndSortGroups(result.groups)[0]?.id);
      this.decisions.set(this.initialDecisions(result));
      this.status.set(result.groups.length ? `分析完成，发现 ${result.groups.length} 个候选组。` : "分析完成，没有发现需要处理的候选组。");
    } catch (error) {
      this.error.set(this.messageFor(error));
    } finally {
      this.analyzing.set(false);
    }
  }

  selectGroup(group: DuplicateGroup): void {
    this.selectedGroupId.set(group.id);
    this.status.set(undefined);
    this.approvedDryRunKey.set(undefined);
    if (!this.scanStale()) {
      this.plan.set(undefined);
    }
    this.executeResult.set(undefined);
  }

  selectPreviousGroup(): void {
    this.selectGroupByOffset(-1);
  }

  selectNextGroup(): void {
    this.selectGroupByOffset(1);
  }

  updateGroupQuery(value: string): void {
    this.groupQuery.set(value);
    this.afterGroupFiltersChanged();
  }

  updateConfidenceFilter(value: "all" | "high" | "medium" | "low"): void {
    this.confidenceFilter.set(value);
    this.afterGroupFiltersChanged();
  }

  updateRuleFilter(value: RuleFilter): void {
    this.ruleFilter.set(value);
    this.afterGroupFiltersChanged();
  }

  updateTraitFilter(value: GroupTraitFilter): void {
    this.traitFilter.set(value);
    this.afterGroupFiltersChanged();
  }

  updateVaultFilter(value: string): void {
    this.vaultFilter.set(value);
    this.afterGroupFiltersChanged();
  }

  updateCategoryFilter(value: string): void {
    this.categoryFilter.set(value);
    this.afterGroupFiltersChanged();
  }

  updateGroupSort(value: "priority" | "size" | "confidence" | "rules"): void {
    this.groupSort.set(value);
    this.afterGroupFiltersChanged();
  }

  clearGroupFilters(): void {
    this.groupQuery.set("");
    this.confidenceFilter.set("all");
    this.ruleFilter.set("all");
    this.traitFilter.set("all");
    this.vaultFilter.set("all");
    this.categoryFilter.set("all");
    this.groupSort.set("priority");
    this.afterGroupFiltersChanged();
  }

  applyConfidenceOverviewFilter(confidence: "high" | "medium" | "low"): void {
    this.confidenceFilter.set(this.confidenceFilter() === confidence ? "all" : confidence);
    this.afterGroupFiltersChanged();
  }

  applyTraitOverviewFilter(trait: Exclude<GroupTraitFilter, "all">): void {
    this.traitFilter.set(this.traitFilter() === trait ? "all" : trait);
    this.afterGroupFiltersChanged();
  }

  setCandidateTab(tab: CandidateTab): void {
    this.activeCandidateTab.set(tab);
    this.afterGroupFiltersChanged();
  }

  setActiveVault(vaultId: string): void {
    this.activeVaultId.set(vaultId);
  }

  updateVaultQuery(value: string): void {
    this.vaultQuery.set(value);
  }

  decisionFor(item: ItemSummary): ItemDecision {
    return (
      this.decisions()[item.id] ?? {
        itemId: item.id,
        keep: false,
        targetVaultId: item.vaultId,
        deleteMode: "archive"
      }
    );
  }

  updateKeep(item: ItemSummary, keep: boolean): void {
    this.patchDecision(item, { keep });
  }

  updateTargetVault(item: ItemSummary, targetVaultId: string): void {
    this.patchDecision(item, { targetVaultId });
  }

  updateDeleteMode(item: ItemSummary, deleteMode: "archive" | "delete"): void {
    this.patchDecision(item, { deleteMode });
  }

  applyRecommendedKeeps(): void {
    const group = this.selectedGroup();
    if (!group) {
      return;
    }
    const recommended = new Set(group.recommendedKeepIds);
    this.patchSelectedGroupDecisions((item, current) => ({
      ...current,
      keep: recommended.has(item.id),
      targetVaultId: item.vaultId,
      deleteMode: "archive"
    }));
  }

  keepAllSelectedItems(): void {
    this.patchSelectedGroupDecisions((item, current) => ({
      ...current,
      keep: true,
      targetVaultId: current.targetVaultId || item.vaultId,
      deleteMode: "archive"
    }));
  }

  archiveAllNonKeptItems(): void {
    this.patchSelectedGroupDecisions((_item, current) => ({
      ...current,
      deleteMode: current.keep ? current.deleteMode : "archive"
    }));
  }

  async previewPlan(): Promise<void> {
    const decision = this.currentGroupDecision();
    if (!decision) {
      return;
    }
    this.loading.set(true);
    this.error.set(undefined);
    this.status.set(undefined);
    try {
      this.plan.set(await this.api.createPlan(decision));
    } catch (error) {
      this.error.set(this.messageFor(error));
    } finally {
      this.loading.set(false);
    }
  }

  async dryRunPlan(): Promise<void> {
    const decision = this.currentGroupDecision();
    if (!decision) {
      return;
    }
    this.loading.set(true);
    this.error.set(undefined);
    this.status.set(undefined);
    try {
      const result = await this.api.execute({ ...decision, dryRun: true });
      if (this.isExecuteResponse(result) && result.plan) {
        this.executeResult.set(result);
        this.plan.set(result.plan);
        this.approvedDryRunKey.set(this.isSuccessfulDryRun(result) ? result.dryRunKey : undefined);
      }
    } catch (error) {
      this.error.set(this.messageFor(error));
    } finally {
      this.loading.set(false);
    }
  }

  async skipSelectedGroup(): Promise<void> {
    const result = this.scanResult();
    const group = this.selectedGroup();
    if (!result || !group) {
      return;
    }
    if (!window.confirm("跳过该重复组？这只会从当前整理列表中移除它，不会改动 1Password 数据。")) {
      return;
    }

    this.loading.set(true);
    this.error.set(undefined);
    this.status.set(undefined);
    const previousGroupIndex = this.selectedGroupIndex();
    try {
      const response = await this.api.skipGroup(result.scanId, group.id);
      this.scanResult.set(response.scan);
      this.restorableSkippedGroupCount.set(response.restorableSkippedGroupCount);
      this.plan.set(undefined);
      this.executeResult.set(undefined);
      this.approvedDryRunKey.set(undefined);
      this.selectVisibleGroupAtOrNear(previousGroupIndex);
      this.status.set(`已跳过 1 个重复组，剩余 ${response.scan.groups.length} 组。`);
    } catch (error) {
      this.error.set(this.messageFor(error));
    } finally {
      this.loading.set(false);
    }
  }

  async restoreLastSkippedGroup(): Promise<void> {
    const result = this.scanResult();
    if (!result || this.restorableSkippedGroupCount() === 0) {
      return;
    }

    this.loading.set(true);
    this.error.set(undefined);
    this.status.set(undefined);
    try {
      const response = await this.api.restoreSkippedGroup(result.scanId);
      this.scanResult.set(response.scan);
      this.restorableSkippedGroupCount.set(response.restorableSkippedGroupCount);
      this.plan.set(undefined);
      this.executeResult.set(undefined);
      this.approvedDryRunKey.set(undefined);
      this.scanStale.set(false);
      this.selectedGroupId.set(response.restoredGroupId);
      this.status.set("已恢复上次跳过的重复组。");
    } catch (error) {
      this.error.set(this.messageFor(error));
    } finally {
      this.loading.set(false);
    }
  }

  async clearScan(): Promise<void> {
    if (!this.scanData() && !this.scanProgress()) {
      return;
    }
    if (!window.confirm("清空当前扫描结果和本地缓存？这不会改动 1Password 数据。")) {
      return;
    }

    this.loading.set(true);
    this.error.set(undefined);
    this.status.set(undefined);
    try {
      await this.api.clearScan();
      this.scanSnapshot.set(undefined);
      this.scanProgress.set(undefined);
      this.scanResult.set(undefined);
      this.activeScanMode.set(undefined);
      this.initialGroupCount.set(0);
      this.restorableSkippedGroupCount.set(0);
      this.selectedGroupId.set(undefined);
      this.activeVaultId.set(undefined);
      this.vaultQuery.set("");
      this.decisions.set({});
      this.revealedCredentials.set({});
      this.plan.set(undefined);
      this.executeResult.set(undefined);
      this.approvedDryRunKey.set(undefined);
      this.scanStale.set(false);
      this.activeCandidateTab.set("similar-login");
      this.status.set("已清空当前扫描结果和本地缓存。");
    } catch (error) {
      this.error.set(this.messageFor(error));
    } finally {
      this.loading.set(false);
    }
  }

  async executePlan(): Promise<void> {
    const decision = this.currentGroupDecision();
    const currentPlan = this.plan();
    if (!decision || !currentPlan || currentPlan.blockers.length > 0) {
      return;
    }
    if (this.currentPlanRequiresDryRun() && !this.approvedDryRunKey()) {
      this.error.set("请先成功试运行当前计划，再执行真实变更。");
      return;
    }
    if (this.liveExecutionDisabled()) {
      this.error.set(this.mutationDisabledHint());
      return;
    }
    let permanentDeletePhrase: string | undefined;
    if (currentPlan.requiresExplicitDeleteConfirmation) {
      const typedPhrase = window.prompt(`该计划包含永久删除。请输入“${permanentDeleteConfirmationPhrase}”确认不可恢复地删除这些项目。`);
      if (typedPhrase !== permanentDeleteConfirmationPhrase) {
        this.error.set(`永久删除需要输入“${permanentDeleteConfirmationPhrase}”确认。`);
        return;
      }
      permanentDeletePhrase = typedPhrase;
    }
    if (!window.confirm("确认执行该组的去重计划？未保留项会被归档或删除。")) {
      return;
    }
    this.loading.set(true);
    this.error.set(undefined);
    this.status.set(undefined);
    const previousGroupIndex = this.selectedGroupIndex();
    try {
      const result = await this.api.execute({
        ...decision,
        confirmPermanentDelete: Boolean(permanentDeletePhrase),
        permanentDeleteConfirmationPhrase: permanentDeletePhrase,
        confirmedDryRunKey: this.approvedDryRunKey()
      });
      if (this.isExecuteResponse(result) && result.plan) {
        this.executeResult.set(result);
        this.plan.set(result.plan);
      }
      if (this.isExecuteResponse(result) && result.scan) {
        this.scanResult.set(result.scan);
        this.plan.set(undefined);
        this.executeResult.set(undefined);
        this.approvedDryRunKey.set(undefined);
        this.restorableSkippedGroupCount.set(0);
        this.selectVisibleGroupAtOrNear(previousGroupIndex);
        this.status.set(
          result.completedGroupId
            ? `已完成 1 个重复组，剩余 ${result.scan.groups.length} 组。`
            : `扫描结果已更新，剩余 ${result.scan.groups.length} 组。`
        );
      }
      if (this.isExecuteResponse(result) && result.scanInvalidated) {
        this.scanStale.set(true);
        this.plan.set(undefined);
        this.approvedDryRunKey.set(undefined);
        this.restorableSkippedGroupCount.set(0);
      }
    } catch (error) {
      this.error.set(this.messageFor(error));
    } finally {
      this.loading.set(false);
    }
  }

  resultActionLabel(result: ExecuteActionResult): string {
    if (result.action === "keep") {
      return "保留";
    }
    if (result.action === "archive") {
      return "归档";
    }
    if (result.action === "delete") {
      return "永久删除";
    }
    if (result.action === "copy-to-vault-and-archive-source") {
      const action = this.plan()?.actions.find((candidate) => candidate.itemId === result.itemId);
      if (action?.type === "copy-to-vault-and-archive-source") {
        return `复制到 ${this.vaultLabel(action.targetVaultId)} 后归档原项`;
      }
      return "复制到目标保险库后归档原项";
    }
    return result.action;
  }

  resultStatusLabel(result: ExecuteActionResult): string {
    if (result.skipped) {
      return "已跳过";
    }
    if (result.dryRun) {
      return result.ok ? "试运行通过" : "试运行失败";
    }
    return result.ok ? "成功" : "失败";
  }

  authModeLabel(): string {
    const session = this.session();
    if (!session) {
      return "未连接";
    }
    if (session.hasServiceAccountToken) {
      return "Service account token";
    }
    if (this.accountName().trim()) {
      return "Desktop App 交互授权";
    }
    return "Desktop App 授权：需填写账户标识";
  }

  appModeLabel(): string {
    const session = this.session();
    if (!session) {
      return "连接中";
    }
    return session.apiBaseUrl === this.clientOrigin ? "单服务生产模式" : "开发代理模式";
  }

  mutationModeLabel(): string {
    const session = this.session();
    if (!session) {
      return "未知";
    }
    if (session.enableMutations) {
      return "已启用";
    }
    return session.forceDryRun ? "已禁用（开发保护）" : "已禁用";
  }

  mutationDisabledHint(): string {
    const session = this.session();
    if (session?.forceDryRun) {
      return "真实变更当前已被开发保护禁用。请继续使用试运行；只有取消 OP_FORCE_DRY_RUN 并显式设置 OP_ENABLE_MUTATIONS=true 后才能执行真实归档、删除或迁移。";
    }
    return "真实变更当前已禁用。请继续使用试运行；只有显式设置 OP_ENABLE_MUTATIONS=true 后才能执行真实归档、删除或迁移。";
  }

  groupPositionLabel(): string {
    const index = this.selectedGroupIndex();
    const total = this.groups().length;
    return index >= 0 ? `${index + 1} / ${total}` : `0 / ${total}`;
  }

  itemLabel(itemId: string): string {
    const item = this.scanData()?.items.find((candidate) => candidate.id === itemId);
    return item ? `${item.title} · ${item.vaultName}` : itemId;
  }

  activeVaultName(): string {
    const activeVaultId = this.activeVaultId();
    if (!activeVaultId) {
      return this.vaultProgress()[0]?.name ?? "Dashboard";
    }
    return this.vaultProgress().find((vault) => vault.id === activeVaultId)?.name ?? this.vaultLabel(activeVaultId);
  }

  scanProgressPercent(): number {
    const progress = this.scanProgress();
    if (!progress) {
      return this.scanData() ? 100 : 0;
    }
    if (progress.totalItems <= 0) {
      return progress.phase === "completed" ? 100 : 0;
    }
    return Math.max(0, Math.min(100, Math.round((progress.scannedItems / progress.totalItems) * 100)));
  }

  scanProgressLabel(): string {
    const progress = this.scanProgress();
    if (!progress) {
      const data = this.scanData();
      return data ? `${data.items.length}/${data.items.length}` : "0/0";
    }
    return `${progress.scannedItems}/${progress.totalItems}`;
  }

  scanPhaseLabel(): string {
    const progress = this.scanProgress();
    if (this.analyzing()) {
      return "正在分析";
    }
    if (!progress) {
      return "等待扫描";
    }
    if (progress.phase === "completed") {
      return "扫描完成";
    }
    if (progress.phase === "failed") {
      return "扫描失败";
    }
    return "扫描中";
  }

  scanProgressMessage(): string {
    const progress = this.scanProgress();
    if (progress?.message) {
      return progress.message;
    }
    if (this.scanComplete() && !this.analysisReady()) {
      return "扫描完成，等待手动分析。";
    }
    return "扫描期间只读取 1Password 数据，不做重复分析。";
  }

  analysisEmptyTitle(): string {
    if (this.loading()) {
      return "等待分析";
    }
    if (this.analyzing()) {
      return "正在分析";
    }
    if (this.scanComplete() && !this.analysisReady()) {
      return "扫描完成，尚未分析";
    }
    return "暂无分析结果";
  }

  analysisEmptyMessage(): string {
    if (this.loading()) {
      return "扫描期间这里保持空态；读取完成后可以手动运行分析。";
    }
    if (this.analyzing()) {
      return "正在根据重复语义生成候选组。";
    }
    if (this.scanComplete() && !this.analysisReady()) {
      return "点击左侧重新分析后，候选组会出现在这里。";
    }
    return "先完成扫描，再运行分析。";
  }

  revealedCredentialFields(item: ItemSummary): RevealCredentialsResponse["fields"] | undefined {
    const revealed = this.revealedCredentials()[item.id];
    if (!revealed || revealed.expiresAt <= Date.now()) {
      return undefined;
    }
    return revealed.fields;
  }

  credentialMaterialDisplay(item: ItemSummary): string {
    const fields = this.revealedCredentialFields(item);
    if (fields?.length) {
      return fields.map((field) => field.value).join(" / ");
    }
    return this.credentialMaterialLabel(item) === "缺少凭据材料" ? "缺少凭据材料" : "••••••••";
  }

  credentialMaterialMeta(item: ItemSummary): string {
    const fields = this.revealedCredentialFields(item);
    if (fields?.length) {
      return fields.map((field) => field.label).join(" / ");
    }
    return this.credentialMaterialLabel(item);
  }

  async toggleCredentialReveal(item: ItemSummary): Promise<void> {
    if (this.revealedCredentialFields(item)) {
      this.removeRevealedCredential(item.id);
      return;
    }
    if (this.credentialMaterialLabel(item) === "缺少凭据材料") {
      return;
    }

    const scan = this.scanData();
    if (!scan) {
      this.error.set("请先完成扫描。");
      return;
    }

    this.error.set(undefined);
    try {
      const response = await this.api.revealCredentials(scan.scanId, item.id);
      const expiresAt = Date.now() + response.expiresInSeconds * 1000;
      this.revealedCredentials.update((credentials) => ({
        ...credentials,
        [item.id]: {
          fields: response.fields,
          expiresAt
        }
      }));
      globalThis.setTimeout(() => {
        const current = this.revealedCredentials()[item.id];
        if (current?.expiresAt === expiresAt) {
          this.removeRevealedCredential(item.id);
        }
      }, response.expiresInSeconds * 1000);
    } catch (error) {
      this.error.set(this.messageFor(error));
    }
  }

  actionLabel(action: PlanAction): string {
    if (action.type === "keep") {
      return "保留";
    }
    if (action.type === "archive") {
      return "归档";
    }
    if (action.type === "delete") {
      return "永久删除";
    }
    if (action.type === "copy-to-vault-and-archive-source") {
      return `复制到 ${this.vaultLabel(action.targetVaultId)} 后归档原项`;
    }
    return action.type;
  }

  planAffectedVaultLabels(plan: ExecutionPlan): string {
    return plan.summary.affectedVaultIds.map((vaultId) => this.vaultLabel(vaultId)).join(" / ");
  }

  reasonLabels(group: DuplicateGroup): string {
    return group.reasons.map((reason) => reason.rule).filter((value, index, values) => values.indexOf(value) === index).join(" / ");
  }

  groupVaultLabels(group: DuplicateGroup): string {
    const result = this.scanResult();
    if (!result) {
      return "";
    }
    const itemById = new Map(result.items.map((item) => [item.id, item]));
    return Array.from(new Set(group.itemIds.map((id) => itemById.get(id)?.vaultName).filter(Boolean))).join(" / ");
  }

  groupBadges(group: DuplicateGroup): string[] {
    const items = this.itemsForGroup(group);
    const vaultCount = new Set(items.map((item) => item.vaultId)).size;
    const badges = [this.candidateClassLabel(this.candidateClassForGroup(group)), `建议保留 ${group.recommendedKeepIds.length}`];

    if (vaultCount > 1) {
      badges.push("跨保险库");
    }
    if (items.some((item) => item.hasTotp)) {
      badges.push("含 TOTP");
    }
    if (items.some((item) => item.hasPasskey)) {
      badges.push("含 Passkey");
    }
    if (items.some((item) => item.hasAttachments)) {
      badges.push("含附件");
    }
    if (group.confidence === "low") {
      badges.push("需人工确认");
    }

    return badges;
  }

  groupAnchorLabel(group: DuplicateGroup): string {
    const items = this.itemsForGroup(group);
    const first = items[0];
    if (!first) {
      return group.id;
    }
    const site = this.itemSiteLabel(first);
    const username = this.itemUsernameLabel(first);
    if (site !== "-" && username !== "-") {
      return `${site} · ${username}`;
    }
    if (site !== "-") {
      return site;
    }
    return first.title;
  }

  groupAnchorKind(group: DuplicateGroup): string {
    const candidateClass = this.candidateClassForGroup(group);
    if (candidateClass === "similar-login") {
      return group.reasons.some((reason) => reason.rule === "username-url") ? "domain + 用户名" : "站点";
    }
    if (candidateClass === "exact") {
      return "全等候选";
    }
    if (candidateClass === "delete-suggestion") {
      return "缺少核心字段";
    }
    return "非登录标题";
  }

  candidateClassLabel(candidateClass: CandidateTab): string {
    if (candidateClass === "similar-login") {
      return "疑似相似";
    }
    if (candidateClass === "exact") {
      return "全等重复";
    }
    if (candidateClass === "delete-suggestion") {
      return "可删除建议";
    }
    return "杂项组";
  }

  candidateHintFor(group: DuplicateGroup): string {
    const candidateClass = this.candidateClassForGroup(group);
    if (candidateClass === "similar-login") {
      return "这些登录项在站点和用户名上相似，可能是同一凭据的多个版本。";
    }
    if (candidateClass === "exact") {
      return "这些项目高度接近，适合优先确认是否只保留一份。";
    }
    if (candidateClass === "delete-suggestion") {
      return "这些登录项缺少用户名、密码、一次性密码或登录方式，建议人工确认是否归档或删除。";
    }
    return "这些非登录信息类项目标题相同，作为低优先级杂项候选供人工整理。";
  }

  itemSiteLabel(item: ItemSummary): string {
    const url = item.urls[0];
    if (!url) {
      return "-";
    }
    return this.domainForUrl(url);
  }

  itemUsernameLabel(item: ItemSummary): string {
    return item.usernames[0] || "-";
  }

  credentialMaterialLabel(item: ItemSummary): string {
    const parts: string[] = [];
    if (item.hasPassword || item.comparableFields.some((field) => field.kind === "secret")) {
      parts.push("密码");
    }
    if (item.hasTotp) {
      parts.push("一次性密码");
    }
    if (item.hasPasskey) {
      parts.push("登录方式");
    }
    return parts.length ? parts.join(" / ") : "缺少凭据材料";
  }

  categoryLabel(category: string): string {
    return itemCategoryCatalog.find((item) => item.category === category)?.label ?? category;
  }

  recommendationLabelsFor(item: ItemSummary): string[] {
    const group = this.selectedGroup();
    if (!group?.recommendedKeepIds.includes(item.id)) {
      return [];
    }
    return group.recommendedKeepReasons.find((reason) => reason.itemId === item.id)?.labels ?? ["推荐保留"];
  }

  private currentGroupDecision(): GroupDecision | undefined {
    const result = this.scanResult();
    const group = this.selectedGroup();
    if (!result || !group) {
      return undefined;
    }
    return {
      scanId: result.scanId,
      groupId: group.id,
      items: this.selectedItems().map((item) => this.decisionFor(item))
    };
  }

  private removeRevealedCredential(itemId: string): void {
    this.revealedCredentials.update((credentials) => {
      const next = { ...credentials };
      delete next[itemId];
      return next;
    });
  }

  private patchDecision(item: ItemSummary, patch: Partial<ItemDecision>): void {
    const current = this.decisionFor(item);
    this.decisions.update((decisions) => ({
      ...decisions,
      [item.id]: {
        ...current,
        itemId: item.id,
        targetVaultId: current.targetVaultId || item.vaultId,
        deleteMode: current.deleteMode || "archive",
        ...patch
      }
    }));
    this.plan.set(undefined);
    this.executeResult.set(undefined);
    this.approvedDryRunKey.set(undefined);
  }

  private patchSelectedGroupDecisions(patcher: (item: ItemSummary, current: ItemDecision) => ItemDecision): void {
    const items = this.selectedItems();
    if (items.length === 0) {
      return;
    }

    this.decisions.update((decisions) => {
      const next = { ...decisions };
      for (const item of items) {
        next[item.id] = patcher(item, this.decisionFor(item));
      }
      return next;
    });
    this.plan.set(undefined);
    this.executeResult.set(undefined);
    this.approvedDryRunKey.set(undefined);
  }

  private initialDecisions(result: ScanResult): Record<string, ItemDecision> {
    const decisions: Record<string, ItemDecision> = {};
    for (const group of result.groups) {
      for (const itemId of group.itemIds) {
        const item = result.items.find((candidate) => candidate.id === itemId);
        if (!item) {
          continue;
        }
        decisions[itemId] = {
          itemId,
          keep: group.recommendedKeepIds.includes(itemId),
          targetVaultId: item.vaultId,
          deleteMode: "archive"
        };
      }
    }
    return decisions;
  }

  private messageFor(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) {
      return String(error.message);
    }
    return String(error);
  }

  private requiresDesktopAccountName(): boolean {
    const session = this.session();
    return this.scanMode() === "live" && !session?.hasServiceAccountToken && !this.accountName().trim();
  }

  private readStoredAccountName(): string | undefined {
    try {
      if (typeof localStorage === "undefined") {
        return undefined;
      }
      const value = localStorage.getItem(desktopAccountNameStorageKey)?.trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private persistAccountName(value: string): void {
    try {
      if (typeof localStorage === "undefined") {
        return;
      }
      const trimmed = value.trim();
      if (trimmed) {
        localStorage.setItem(desktopAccountNameStorageKey, trimmed);
      } else {
        localStorage.removeItem(desktopAccountNameStorageKey);
      }
    } catch {
      // localStorage may be unavailable in restrictive browser modes; the current input still works.
    }
  }

  private isExecuteResponse(value: unknown): value is ExecuteResponse {
    return Boolean(
      value &&
        typeof value === "object" &&
        ("scanInvalidated" in value ||
          "scan" in value ||
          "plan" in value ||
          "dryRun" in value ||
          "results" in value ||
          "blocked" in value)
    );
  }

  private isSuccessfulDryRun(result: ExecuteResponse): boolean {
    return Boolean(
      result.dryRun &&
        result.dryRunKey &&
        !result.blocked &&
        (result.results ?? []).length > 0 &&
        (result.results ?? []).every((item) => item.ok)
    );
  }

  private vaultLabel(vaultId: string): string {
    return this.vaults().find((vault) => vault.id === vaultId)?.name ?? vaultId;
  }

  private itemsForGroup(group: DuplicateGroup): ItemSummary[] {
    const result = this.scanResult();
    if (!result) {
      return [];
    }
    const itemById = new Map(result.items.map((item) => [item.id, item]));
    return group.itemIds.map((id) => itemById.get(id)).filter((item): item is ItemSummary => Boolean(item));
  }

  private groupPriority(group: DuplicateGroup): number {
    const items = this.itemsForGroup(group);
    const vaultCount = new Set(items.map((item) => item.vaultId)).size;
    return (
      confidenceRank(group.confidence) * 100 +
      group.reasons.length * 12 +
      group.itemIds.length * 8 +
      (vaultCount > 1 ? 10 : 0) +
      (items.some((item) => item.hasTotp || item.hasPasskey || item.hasAttachments) ? 8 : 0)
    );
  }

  private filterAndSortGroups(groups: DuplicateGroup[]): DuplicateGroup[] {
    const query = this.groupQuery().trim().toLowerCase();
    const candidateTab = this.activeCandidateTab();
    const confidence = this.confidenceFilter();
    const rule = this.ruleFilter();
    const trait = this.traitFilter();
    const vault = this.vaultFilter();
    const category = this.categoryFilter();
    const result = this.scanResult();
    const itemById = new Map(result?.items.map((item) => [item.id, item]) ?? []);

    return groups
      .filter((group) => this.candidateClassForGroup(group) === candidateTab)
      .filter((group) => confidence === "all" || group.confidence === confidence)
      .filter((group) => rule === "all" || group.reasons.some((reason) => reason.rule === rule))
      .filter((group) => trait === "all" || this.groupHasTrait(group, trait))
      .filter((group) => {
        if (vault === "all" && category === "all") {
          return true;
        }
        const items = group.itemIds.map((id) => itemById.get(id)).filter((item): item is ItemSummary => Boolean(item));
        return items.some((item) =>
          (vault === "all" || item.vaultId === vault) &&
          (category === "all" || item.category === category)
        );
      })
      .filter((group) => {
        if (!query) {
          return true;
        }
        const reasonText = group.reasons.map((reason) => reason.label).join(" ");
        const itemText = group.itemIds
          .map((id) => {
            const item = itemById.get(id);
            return item ? `${item.title} ${item.vaultName} ${item.urls.join(" ")}` : id;
          })
          .join(" ");
        return `${reasonText} ${itemText}`.toLowerCase().includes(query);
      })
      .slice()
      .sort((a, b) => {
        if (this.groupSort() === "priority") {
          return this.groupPriority(b) - this.groupPriority(a) || b.itemIds.length - a.itemIds.length;
        }
        if (this.groupSort() === "confidence") {
          return confidenceRank(b.confidence) - confidenceRank(a.confidence) || b.itemIds.length - a.itemIds.length;
        }
        if (this.groupSort() === "rules") {
          return b.reasons.length - a.reasons.length || b.itemIds.length - a.itemIds.length;
        }
        return b.itemIds.length - a.itemIds.length || b.reasons.length - a.reasons.length;
      });
  }

  private afterGroupFiltersChanged(): void {
    const visibleGroups = this.groups();
    if (!visibleGroups.some((group) => group.id === this.selectedGroupId())) {
      this.selectedGroupId.set(visibleGroups[0]?.id);
    }
    this.status.set(undefined);
    this.plan.set(undefined);
    this.executeResult.set(undefined);
    this.approvedDryRunKey.set(undefined);
  }

  private buildGroupOverview(): GroupOverview {
    const groups = this.allGroups();
    return groups.reduce(
      (overview, group) => {
        overview.total += 1;
        overview[group.confidence] += 1;
        if (this.groupHasTrait(group, "cross-vault")) {
          overview.crossVault += 1;
        }
        if (this.groupHasTrait(group, "totp")) {
          overview.totp += 1;
        }
        if (this.groupHasTrait(group, "passkey")) {
          overview.passkey += 1;
        }
        if (this.groupHasTrait(group, "attachments")) {
          overview.attachments += 1;
        }
        return overview;
      },
      {
        total: 0,
        visible: this.groups().length,
        high: 0,
        medium: 0,
        low: 0,
        crossVault: 0,
        totp: 0,
        passkey: 0,
        attachments: 0
      }
    );
  }

  private groupHasTrait(group: DuplicateGroup, trait: GroupTraitFilter): boolean {
    if (trait === "all") {
      return true;
    }

    const items = this.itemsForGroup(group);
    if (trait === "cross-vault") {
      return new Set(items.map((item) => item.vaultId)).size > 1;
    }
    if (trait === "totp") {
      return items.some((item) => item.hasTotp);
    }
    if (trait === "passkey") {
      return items.some((item) => item.hasPasskey);
    }
    return items.some((item) => item.hasAttachments);
  }

  private candidateClassForGroup(group: DuplicateGroup): CandidateTab {
    if (group.candidateClass === "similar-login") {
      return "similar-login";
    }
    if (group.candidateClass === "exact-duplicate") {
      return "exact";
    }
    if (group.candidateClass === "delete-suggestion") {
      return "delete-suggestion";
    }
    if (group.candidateClass === "misc-title") {
      return "misc";
    }

    const items = this.itemsForGroup(group);
    const loginItems = items.filter((item) => item.category === "login");
    if (loginItems.some((item) => this.isDeleteSuggestionItem(item))) {
      return "delete-suggestion";
    }
    if (loginItems.length > 0 && group.reasons.some((reason) => reason.rule === "username-url" || reason.rule === "url")) {
      return "similar-login";
    }
    if (
      group.confidence === "high" &&
      group.reasons.some((reason) => reason.rule === "url") &&
      group.reasons.some((reason) => reason.rule === "title")
    ) {
      return "exact";
    }
    return "misc";
  }

  private firstAvailableCandidateTab(result: ScanResult): CandidateTab {
    const counts: Record<CandidateTab, number> = {
      "similar-login": 0,
      exact: 0,
      "delete-suggestion": 0,
      misc: 0
    };
    const previous = this.scanResult();
    this.scanResult.set(result);
    for (const group of result.groups) {
      counts[this.candidateClassForGroup(group)] += 1;
    }
    this.scanResult.set(previous);
    return (["similar-login", "exact", "delete-suggestion", "misc"] as CandidateTab[]).find((tab) => counts[tab] > 0) ?? "similar-login";
  }

  private isDeleteSuggestionItem(item: ItemSummary): boolean {
    if (item.category !== "login") {
      return false;
    }
    return this.itemUsernameLabel(item) === "-" || this.credentialMaterialLabel(item) === "缺少凭据材料";
  }

  private domainForUrl(value: string): string {
    const raw = value.trim();
    if (!raw) {
      return "-";
    }
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      return new URL(withProtocol).hostname.replace(/^www\./i, "") || raw;
    } catch {
      return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0] || raw;
    }
  }

  private selectGroupByOffset(offset: number): void {
    const groups = this.groups();
    const index = this.selectedGroupIndex();
    if (index < 0) {
      const firstGroup = groups[0];
      if (firstGroup) {
        this.selectGroup(firstGroup);
      }
      return;
    }

    const nextGroup = groups[index + offset];
    if (nextGroup) {
      this.selectGroup(nextGroup);
    }
  }

  private selectVisibleGroupAtOrNear(index: number): void {
    const groups = this.groups();
    if (groups.length === 0) {
      this.selectedGroupId.set(undefined);
      return;
    }

    const nextIndex = Math.max(0, Math.min(index, groups.length - 1));
    this.selectedGroupId.set(groups[nextIndex]?.id);
  }
}

function confidenceRank(confidence: DuplicateGroup["confidence"]): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}
