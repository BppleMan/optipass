import { CommonModule } from "@angular/common";
import { Component, computed, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import {
  DuplicateGroup,
  ExecutionPlan,
  GroupDecision,
  ItemDecision,
  ItemSummary,
  PlanAction,
  ScanResult
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
type GroupTraitFilter = "all" | "cross-vault" | "totp" | "passkey" | "attachments";

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

@Component({
  selector: "op-root",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./app.component.html"
})
export class AppComponent implements OnInit {
  readonly scanResult = signal<ScanResult | undefined>(undefined);
  readonly selectedGroupId = signal<string | undefined>(undefined);
  readonly loading = signal(false);
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
  readonly ruleFilter = signal<"all" | "title" | "url" | "username-url" | "secret" | "field">("all");
  readonly traitFilter = signal<GroupTraitFilter>("all");
  readonly vaultFilter = signal("all");
  readonly categoryFilter = signal("all");
  readonly groupSort = signal<"priority" | "size" | "confidence" | "rules">("priority");
  readonly decisions = signal<Record<string, ItemDecision>>({});
  readonly session = computed(() => this.api.session());
  readonly clientOrigin = typeof window === "undefined" ? "unknown" : window.location.origin;

  readonly groups = computed(() => this.filterAndSortGroups(this.scanResult()?.groups ?? []));
  readonly allGroups = computed(() => this.scanResult()?.groups ?? []);
  readonly groupOverview = computed(() => this.buildGroupOverview());
  readonly vaults = computed(() => this.scanResult()?.vaults ?? []);
  readonly categories = computed(() => {
    const result = this.scanResult();
    if (!result) {
      return [];
    }
    return Array.from(new Set(result.items.map((item) => item.category))).sort();
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
      this.accountName.set(session.accountName ?? "");
    } catch (error) {
      this.error.set(this.messageFor(error));
    }
  }

  async scan(): Promise<void> {
    this.loading.set(true);
    this.error.set(undefined);
    this.status.set(undefined);
    this.plan.set(undefined);
    this.executeResult.set(undefined);
    this.approvedDryRunKey.set(undefined);
    this.scanStale.set(false);
    try {
      const result = await this.api.scan({ accountName: this.accountName(), mode: this.scanMode() });
      this.scanResult.set(result);
      this.activeScanMode.set(this.scanMode());
      this.initialGroupCount.set(result.groups.length);
      this.restorableSkippedGroupCount.set(0);
      this.selectedGroupId.set(this.filterAndSortGroups(result.groups)[0]?.id);
      this.decisions.set(this.initialDecisions(result));
    } catch (error) {
      this.error.set(this.messageFor(error));
    } finally {
      this.loading.set(false);
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

  updateRuleFilter(value: "all" | "title" | "url" | "username-url" | "secret" | "field"): void {
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
    if (!this.scanResult()) {
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
      this.scanResult.set(undefined);
      this.activeScanMode.set(undefined);
      this.initialGroupCount.set(0);
      this.restorableSkippedGroupCount.set(0);
      this.selectedGroupId.set(undefined);
      this.decisions.set({});
      this.plan.set(undefined);
      this.executeResult.set(undefined);
      this.approvedDryRunKey.set(undefined);
      this.scanStale.set(false);
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
      return "Desktop App 授权";
    }
    return "等待账户名";
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
    const item = this.scanResult()?.items.find((candidate) => candidate.id === itemId);
    return item ? `${item.title} · ${item.vaultName}` : itemId;
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
    const badges = [`建议保留 ${group.recommendedKeepIds.length}`];

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
    const confidence = this.confidenceFilter();
    const rule = this.ruleFilter();
    const trait = this.traitFilter();
    const vault = this.vaultFilter();
    const category = this.categoryFilter();
    const result = this.scanResult();
    const itemById = new Map(result?.items.map((item) => [item.id, item]) ?? []);

    return groups
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
