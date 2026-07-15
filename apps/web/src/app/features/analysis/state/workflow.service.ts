import { computed, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  createActionPlanGroup,
  dashboardCategoryDefinitions,
  normalizeLooseText,
  normalizeUrlHost,
  summarizeVaults,
  type DashboardCategory,
  type ActionDraft,
  type SimilarityGroup,
  type ActionDraftItem,
  type ActionPlanGroup,
  type GroupDecision,
  type ItemSummary,
  type PlanAction,
  type RevealedCredentialField,
  type ScanProgress,
  type ScanProgressEvent,
  type ScanResult,
  type ScanSnapshot,
  type VaultScanSummary,
  type VaultSummary
} from '@optimize-password/core';
import {
  ApiService,
  type ActiveScanResponse,
  type AnalysisResultResponse,
  type ActionExecutionEvent,
  type ActionExecutionStatus,
  type DryRunSpeedMultiplier
} from '../../../core/services/api.service';
import {
  type AnalysisFilterChipView,
  type AnalysisFilterKey,
  type AnalysisFilterSectionId,
  type AnalysisFilterSectionView,
  type AnalysisFilterSummaryView,
  type ApplyOperationGroupView,
  type ApplyOperationRowView,
  type ApplyOperationView,
  type ApplyStatus,
  type CredentialChipView,
  type DecisionStatsView,
  type DuplicateGroupView,
  type DuplicateItemView,
  type FilterCredentialKind,
  type PlanActionPreviewView,
  type PreviewGroupView,
  type RemoveAction,
  type ScanVaultRow,
  itemUpdatedDate,
  removeActionFromDecision
} from '../../../core/models/workflow.models';

const accountNameStorageKey = 'optipass.accountName';
const deleteConfirmationPhrase = '永久删除';
const missingYearId = '__missing_year__';
const scanRecoveryTimeoutMs = 120_000;
const scanRecoveryPollMs = 500;

type ActionExecutionViewStatus = ActionExecutionStatus | 'ready' | 'starting';
type ActionExecutionScope = 'plan' | 'group';

const categoryDisplay: Record<string, { label: string; order: number }> = {
  login: { label: '登录', order: 1 },
  password: { label: '密码', order: 2 },
  'secure-note': { label: '安全备注', order: 3 },
  'credit-card': { label: '信用卡', order: 4 },
  'api-credential': { label: 'API 凭据', order: 5 },
  database: { label: '数据库', order: 6 },
  'ssh-key': { label: 'SSH 密钥', order: 7 },
  document: { label: '文档', order: 8 },
  identity: { label: '身份', order: 9 },
  server: { label: '服务器', order: 10 },
  'software-license': { label: '软件许可', order: 11 },
  other: { label: '其他', order: 99 }
};

const categoryChipColors: Record<string, string> = {
  login: '#82aaff',
  password: '#f07178',
  'secure-note': '#c792ea',
  'credit-card': '#c3e88d',
  'api-credential': '#ffcb6b',
  database: '#89ddff',
  'ssh-key': '#f78c6c',
  document: '#b0bec5',
  identity: '#c3e88d',
  server: '#82aaff',
  'software-license': '#ffcb6b',
  other: '#727272'
};

interface AnalysisFilterState {
  years: string[];
  vaultIds: string[];
  domains: string[];
  credentialKinds: FilterCredentialKind[];
}

interface AnalysisFilterOptionData {
  id: string;
  label: string;
  count: number;
}

type GlobalSearchSuggestionKind = "year" | "vault" | "domain";

interface GlobalSearchSuggestion {
  id: string;
  kind: GlobalSearchSuggestionKind;
  label: string;
  count: number;
}

interface GlobalSearchSuggestionView extends GlobalSearchSuggestion {
  detail: string;
  index: number;
  selected: boolean;
}

interface GlobalSearchSuggestionGroupView {
  kind: GlobalSearchSuggestionKind;
  label: string;
  allSelected: boolean;
  someSelected: boolean;
  suggestions: GlobalSearchSuggestionView[];
}

const filterSectionMeta: Record<AnalysisFilterSectionId, {
  label: string;
  emptyText: string;
}> = {
  years: {
    label: '年份',
    emptyText: '没有可筛选年份'
  },
  vaults: {
    label: '保险库',
    emptyText: '没有可筛选保险库'
  },
  credentials: {
    label: '凭据类型',
    emptyText: '没有可筛选凭据类型'
  },
  domains: {
    label: 'Domain',
    emptyText: '没有可筛选 domain'
  }
};

const credentialKindMeta: Record<FilterCredentialKind, { label: string; order: number }> = {
  password: { label: '密码', order: 1 },
  totp: { label: '一次性密码', order: 2 },
  passkey: { label: 'Passkey', order: 3 }
};

const globalSearchSuggestionKindLabels: Record<GlobalSearchSuggestionKind, string> = {
  year: "年份匹配项",
  vault: "保险库匹配项",
  domain: "Domain 匹配项",
};

const defaultFilterSectionsOpen: Record<AnalysisFilterSectionId, boolean> = {
  years: true,
  vaults: true,
  domains: true,
  credentials: true
};

@Injectable({ providedIn: 'root' })
export class WorkflowService {
  readonly account = signal('');
  readonly authState = signal<'idle' | 'authorizing' | 'authorized' | 'failed'>('idle');
  readonly activeScanMode = signal<'live' | 'mock'>('live');
  readonly scanProgress = signal<ScanProgress | undefined>(undefined);
  readonly scanSnapshot = signal<ScanSnapshot | undefined>(undefined);
  readonly scanResult = signal<ScanResult | undefined>(undefined);
  readonly loading = signal(false);
  readonly analyzing = signal(false);
  readonly analysisPct = signal(0);
  readonly error = signal<string | undefined>(undefined);
  readonly status = signal<string | undefined>(undefined);
  readonly decisions = signal<Record<string, ActionDraftItem>>({});
  readonly skippedGroups = signal<Record<string, boolean>>({});
  readonly reveal = signal(false);
  readonly visibleSecretItems = signal<Record<string, boolean>>({});
  readonly revealingItems = signal<Record<string, boolean>>({});
  readonly revealedCredentials = signal<Record<string, RevealedCredentialField[]>>({});
  readonly analysisFilters = signal<AnalysisFilterState>(emptyAnalysisFilters());
  readonly filterSectionsOpen = signal<Record<AnalysisFilterSectionId, boolean>>(defaultFilterSectionsOpen);
  readonly globalSearchQuery = signal('');
  readonly globalSearchItemIds = signal<string[] | undefined>(undefined);
  readonly globalSearchSuggestions = signal<GlobalSearchSuggestion[]>([]);
  readonly globalSearchAutocompleteOpen = signal(false);
  readonly activeGlobalSearchSuggestionIndex = signal(0);
  readonly operations = signal<ApplyOperationView[]>([]);
  readonly operationGroupErrors = signal<Record<string, string>>({});
  readonly applying = signal(false);
  readonly applyDialogOpen = signal(false);
  readonly actionExecutionId = signal<string | undefined>(undefined);
  readonly actionExecutionStatus = signal<ActionExecutionViewStatus | undefined>(undefined);
  readonly actionExecutionScope = signal<ActionExecutionScope>('plan');
  readonly actionExecutionWriteEnabled = signal(false);
  readonly groupPlanLoading = signal<Record<string, boolean>>({});
  readonly mutationToggleBusy = signal(false);
  readonly dryRunSpeedMultiplier = signal<DryRunSpeedMultiplier>(1);
  private readonly preparedActionDraft = signal<ActionDraft | undefined>(undefined);
  private scanAbortController: AbortController | undefined;
  private globalSearchRequestId = 0;

  readonly session = computed(() => this.api.session());
  readonly mutationsEnabled = computed(() => Boolean(this.session()?.enableMutations));
  readonly accountChip = computed(() => this.account().trim());
  readonly scanData = computed(() => this.scanResult() ?? this.scanSnapshot());
  readonly scanDone = computed(() => this.scanProgress()?.phase === 'completed' || Boolean(this.scanSnapshot()));
  readonly scanFailed = computed(() => this.scanProgress()?.phase === 'failed' || this.authState() === 'failed');
  readonly scanRows = computed(() => this.buildScanRows());
  readonly totalItems = computed(() => this.scanProgress()?.totalItems || this.scanData()?.items.length || 0);
  readonly scannedTotal = computed(() => this.scanProgress()?.scannedItems || this.scanData()?.items.length || 0);
  readonly overallPct = computed(() => {
    const total = this.totalItems();
    return total ? Math.round((this.scannedTotal() / total) * 100) : 100;
  });
  readonly authHint = computed(() => {
    if (this.error() && this.authState() === 'failed') {
      return this.error();
    }
    if (this.authState() === 'authorizing') {
      if (this.activeScanMode() === 'mock') {
        return '正在载入本地演示扫描数据…';
      }
      return this.scanProgress()?.message || '已向 1Password 请求授权，请在桌面端弹窗中点击「允许」…';
    }
    if (this.authState() === 'authorized') {
      const vaultCount = this.scanData()?.vaults.length || this.scanProgress()?.totalVaults || 0;
      if (this.activeScanMode() === 'mock') {
        return `✓ 已载入演示数据 · 正在扫描 ${vaultCount} 个 vault`;
      }
      return `✓ 授权成功 · 已连接 ${vaultCount} 个 vault，正在扫描`;
    }
    return '';
  });
  readonly groups = computed(() => this.scanResult()?.groups ?? []);
  readonly groupViews = computed<DuplicateGroupView[]>(() => this.buildGroupViews());
  readonly visibleGroups = computed<DuplicateGroupView[]>(() => this.filterGroups(this.groupViews()));
  readonly analysisFilterSections = computed<AnalysisFilterSectionView[]>(() => this.buildAnalysisFilterSections());
  readonly analysisFilterSummary = computed<AnalysisFilterSummaryView>(() => this.buildAnalysisFilterSummary());
  readonly globalSearchSuggestionGroups = computed<GlobalSearchSuggestionGroupView[]>(() => this.buildGlobalSearchSuggestionGroups());
  public readonly selectedGlobalSearchSuggestionCount = computed(() => this.selectedGlobalSearchSuggestions().length);
  public readonly allGlobalSearchSuggestionsSelected = computed(() => {
    const suggestions = this.scopedGlobalSearchSuggestions();
    return suggestions.length > 0 && this.selectedGlobalSearchSuggestions().length === suggestions.length;
  });
  public readonly activeGlobalSearchSuggestionId = computed(() => {
    const id = this.scopedGlobalSearchSuggestions()[this.activeGlobalSearchSuggestionIndex()]?.id;
    return id ? `global-search-suggestion-${id}` : undefined;
  });
  readonly decisionStats = computed<DecisionStatsView>(() => this.buildDecisionStats());
  readonly allPreviewGroups = computed<PreviewGroupView[]>(() => this.buildPreviewGroups());
  readonly visiblePreviewGroups = computed(() => {
    const visibleIds = new Set(this.visibleGroups().map((group) => group.id));
    return this.allPreviewGroups().filter((group) => visibleIds.has(group.id));
  });
  readonly planOperationCount = computed(() => this.countPlanOperations(this.visiblePreviewGroups()));
  readonly canApply = computed(() =>
    this.planOperationCount() > 0 &&
    !this.loading() &&
    !this.applying()
  );
  readonly operationRows = computed<ApplyOperationRowView[]>(() => this.operations().map((operation) => toOperationRow(operation)));
  readonly operationGroups = computed<ApplyOperationGroupView[]>(() => buildOperationGroups(this.operationRows(), this.operationGroupErrors()));
  readonly applyPct = computed(() => {
    const operations = this.operations();
    if (operations.length === 0) {
      return 0;
    }
    const finished = operations.filter((operation) => ['done', 'failed', 'skipped'].includes(operation.status)).length;
    return Math.round((finished / operations.length) * 100);
  });
  readonly summaryLine = computed(() => {
    const operations = this.operations();
    const failed = operations.filter((operation) => operation.status === 'failed').length;
    const skipped = operations.filter((operation) => operation.status === 'skipped').length;
    const success = operations.filter((operation) => operation.status === 'done').length;
    const failedGroups = Object.keys(this.operationGroupErrors()).length;
    return `共执行 ${operations.length} 项操作，成功 ${success} 项${failed ? `，失败 ${failed} 项` : ''}${failedGroups ? `，${failedGroups} 组校验失败` : ''}${skipped ? `，跳过 ${skipped} 项` : ''}`;
  });
  readonly actionExecutionStatusLabel = computed(() => {
    switch (this.actionExecutionStatus()) {
      case 'ready':
        return '待开始';
      case 'starting':
        return '正在启动';
      case 'running':
        return '执行中';
      case 'pause-requested':
        return '正在暂停';
      case 'paused':
        return '已暂停';
      case 'stop-requested':
        return '正在停止';
      case 'stopped':
        return '已停止';
      case 'completed':
        return '已完成';
      case 'failed':
        return '执行失败';
      default:
        return this.applying() ? '正在准备' : '已结束';
    }
  });
  readonly canCloseApplyDialog = computed(() => {
    if (!this.applying()) {
      return true;
    }
    return ['stopped', 'completed', 'failed'].includes(this.actionExecutionStatus() ?? '');
  });

  constructor(
    private readonly api: ApiService,
    private readonly router: Router
  ) {}

  async loadSession(): Promise<void> {
    if (this.session()) {
      return;
    }
    try {
      const session = await this.api.loadSession();
      this.account.set(readStoredAccountName() ?? session.accountName ?? '');
    } catch (error) {
      this.error.set(messageFor(error));
    }
  }

  async setMutationsEnabled(enableMutations: boolean): Promise<void> {
    if (this.mutationToggleBusy() || this.session()?.enableMutations === enableMutations) {
      return;
    }
    this.mutationToggleBusy.set(true);
    this.error.set(undefined);
    try {
      await this.api.setMutationsEnabled(enableMutations);
      this.status.set(enableMutations ? '已切换为可写模式。' : '已切换为试写模式。');
    } catch (error) {
      this.error.set(messageFor(error));
    } finally {
      this.mutationToggleBusy.set(false);
    }
  }

  async restoreCachedState(): Promise<void> {
    await this.loadSession();
    if (this.loading() || this.analyzing() || this.applying()) {
      return;
    }

    if (!this.scanResult()) {
      try {
        const result = await this.api.loadAnalysis();
        this.restoreCachedAccountName();
        this.restoreAnalysisResult(result);
        return;
      } catch {
        // Absence of cached analysis is the normal first-run path.
      }
    }

    if (!this.scanSnapshot()) {
      try {
        const scan = await this.api.loadScan();
        this.restoreCachedAccountName();
        this.restoreScanSnapshot(scan);
        return;
      } catch {
        // Absence of cached scan is the normal first-run path.
      }

      try {
        await this.restoreActiveScan();
      } catch {
        // Absence of an active scan is the normal first-run path.
      }
    }
  }

  updateAccount(value: string): void {
    this.account.set(value);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(accountNameStorageKey, value);
    }
  }

  private restoreCachedAccountName(): void {
    const accountName = this.session()?.resumeAccountName;
    if (accountName) {
      this.updateAccount(accountName);
    }
  }

  async startScan(): Promise<void> {
    await this.loadSession();
    const session = this.session();
    const accountName = this.account().trim();
    const mode = session?.hasServiceAccountToken || accountName ? 'live' : 'mock';
    const resolvedAccountName = accountName || session?.accountName || 'dev@lin.dev';

    this.resetForScan();
    this.account.set(resolvedAccountName);
    this.activeScanMode.set(mode);
    this.loading.set(true);
    this.authState.set('authorizing');
    const scanAbortController = new AbortController();
    this.scanAbortController = scanAbortController;
    try {
      const start = await this.api.startScan({ accountName: resolvedAccountName, mode });
      this.activeScanMode.set(start.mode);
      this.scanProgress.set(start.progress);
      try {
        await this.api.streamScanEvents(start.scanId, start.eventsToken, (event) => {
          this.handleScanProgressEvent(event);
        }, { signal: scanAbortController.signal });
      } catch (error) {
        if (scanAbortController.signal.aborted) {
          return;
        }
        if (!await this.recoverCompletedScanAfterStreamError()) {
          throw error;
        }
      }

      if (scanAbortController.signal.aborted) {
        return;
      }
      if (!this.scanSnapshot() && this.scanProgress()?.phase === 'completed') {
        this.scanSnapshot.set(await this.api.loadScan());
      }
      if (this.scanSnapshot()) {
        this.authState.set('authorized');
        this.status.set('扫描完成。');
      }
    } catch (error) {
      this.authState.set('failed');
      this.error.set(messageFor(error));
    } finally {
      if (this.scanAbortController === scanAbortController) {
        this.scanAbortController = undefined;
      }
      this.loading.set(false);
    }
  }

  private async recoverCompletedScanAfterStreamError(): Promise<boolean> {
    if (this.scanSnapshot() || this.scanProgress()?.phase === 'completed') {
      return true;
    }

    this.status.set('扫描进度流中断，正在等待本地扫描结果。');
    const deadline = Date.now() + scanRecoveryTimeoutMs;
    while (Date.now() <= deadline) {
      try {
        this.scanSnapshot.set(await this.api.loadScan());
        this.authState.set('authorized');
        this.error.set(undefined);
        return true;
      } catch {
        await sleep(scanRecoveryPollMs);
      }
    }
    return false;
  }

  private async restoreActiveScan(): Promise<void> {
    if (this.scanAbortController) {
      return;
    }
    const active = await this.api.loadActiveScan();
    const scanAbortController = new AbortController();
    this.scanAbortController = scanAbortController;
    this.activeScanMode.set(active.mode);
    this.scanProgress.set(active.progress);
    this.authState.set(active.progress.totalVaults > 0 || active.progress.vaults.length > 0 ? 'authorized' : 'authorizing');
    this.loading.set(true);
    this.error.set(undefined);
    this.status.set('已接入正在运行的扫描任务。');
    try {
      await this.api.streamScanEvents(active.scanId, active.eventsToken, (event) => {
        this.handleScanProgressEvent(event);
      }, { signal: scanAbortController.signal, after: active.eventCount });
      if (!this.scanSnapshot() && this.scanProgress()?.phase === 'completed') {
        this.scanSnapshot.set(await this.api.loadScan());
        this.authState.set('authorized');
      }
      if (this.scanSnapshot()) {
        this.status.set('扫描完成。');
      }
    } catch (error) {
      if (!scanAbortController.signal.aborted && !await this.recoverCompletedScanAfterStreamError()) {
        this.authState.set('failed');
        this.error.set(messageFor(error));
      }
    } finally {
      if (this.scanAbortController === scanAbortController) {
        this.scanAbortController = undefined;
      }
      this.loading.set(false);
    }
  }

  private handleScanProgressEvent(event: ScanProgressEvent): void {
    this.scanProgress.set(event.progress);
    if (event.progress.totalVaults > 0 || event.progress.vaults.length > 0) {
      this.authState.set('authorized');
    }
    if (event.scan) {
      this.scanSnapshot.set(event.scan);
      this.authState.set('authorized');
    }
    if (event.type === 'failed') {
      this.authState.set('failed');
      this.error.set(event.error || event.progress.error || '扫描失败，请查看本地 API 日志。');
    }
  }

  async startAnalysis(): Promise<void> {
    const scan = this.scanSnapshot();
    if (!scan || !this.scanDone()) {
      this.error.set('请先完成扫描，再开始分析。');
      await this.router.navigateByUrl('/scan');
      return;
    }

    this.analyzing.set(true);
    this.analysisPct.set(0);
    this.error.set(undefined);
    this.status.set(undefined);
    await this.router.navigateByUrl('/analysis');
    const timer = window.setInterval(() => {
      this.analysisPct.set(Math.min(94, this.analysisPct() + 8));
    }, 80);
    try {
      const result = await this.api.analyze(scan.scanId);
      this.restoreAnalysisResult(result);
      this.clearAnalysisFilters();
      this.analysisPct.set(100);
      this.status.set(result.groups.length ? `分析完成，发现 ${result.groups.length} 组疑似重复。` : '分析完成，没有发现疑似重复。');
    } catch (error) {
      this.error.set(messageFor(error));
    } finally {
      window.clearInterval(timer);
      this.analyzing.set(false);
    }
  }

  async rescan(): Promise<void> {
    this.scanAbortController?.abort();
    this.loading.set(true);
    try {
      await this.api.clearScan();
      this.resetForScan();
      await this.router.navigateByUrl('/scan');
    } catch (error) {
      this.error.set(messageFor(error));
    } finally {
      this.loading.set(false);
    }
  }

  async backToScan(): Promise<void> {
    await this.router.navigateByUrl('/scan');
  }

  toggleAnalysisFilter(sectionId: AnalysisFilterSectionId, optionId: string, selected: boolean): void {
    const current = this.analysisFilters();
    switch (sectionId) {
      case 'years':
        this.analysisFilters.set({ ...current, years: toggleStringValue(current.years, optionId, selected) });
        return;
      case 'vaults':
        this.analysisFilters.set({ ...current, vaultIds: toggleStringValue(current.vaultIds, optionId, selected) });
        return;
      case 'domains':
        this.analysisFilters.set({ ...current, domains: toggleStringValue(current.domains, optionId, selected) });
        return;
      case 'credentials':
        if (isFilterCredentialKind(optionId)) {
          this.analysisFilters.set({ ...current, credentialKinds: toggleCredentialKind(current.credentialKinds, optionId, selected) });
        }
        return;
    }
  }

  removeAnalysisFilter(key: AnalysisFilterKey, optionId: string): void {
    if (key === 'search') {
      this.clearGlobalSearch();
      return;
    }
    const section = sectionIdForFilterKey(key);
    this.toggleAnalysisFilter(section, optionId, false);
  }

  clearAnalysisFilters(): void {
    this.analysisFilters.set(emptyAnalysisFilters());
    this.clearGlobalSearch();
  }

  toggleAnalysisFilterSection(sectionId: AnalysisFilterSectionId): void {
    const open = this.filterSectionsOpen();
    this.filterSectionsOpen.set({ ...open, [sectionId]: !open[sectionId] });
  }

  public async updateGlobalSearchQuery(value: string): Promise<void> {
    this.globalSearchQuery.set(value);
    const keywords = searchKeywords(value);
    const requestId = ++this.globalSearchRequestId;
    this.globalSearchSuggestions.set(this.searchFilterOptions(keywords));
    if (keywords.length === 0) {
      this.globalSearchItemIds.set(undefined);
      this.globalSearchAutocompleteOpen.set(false);
      return;
    }

    this.globalSearchAutocompleteOpen.set(this.globalSearchSuggestions().length > 0);
    try {
      const itemIds = this.groupViews().flatMap((group) => group.items.map((item) => item.id));
      const response = await this.api.searchItems(keywords, itemIds);
      if (requestId === this.globalSearchRequestId) {
        this.globalSearchItemIds.set(response.itemIds);
        this.activeGlobalSearchSuggestionIndex.set(0);
      }
    } catch (error) {
      if (requestId === this.globalSearchRequestId) {
        this.globalSearchItemIds.set([]);
        this.error.set(messageFor(error));
      }
    }
  }

  public openGlobalSearchAutocomplete(): void {
    if (this.globalSearchQuery().trim() && this.scopedGlobalSearchSuggestions().length > 0) {
      this.globalSearchAutocompleteOpen.set(true);
    }
  }

  closeGlobalSearchAutocomplete(): void {
    this.globalSearchAutocompleteOpen.set(false);
  }

  public moveGlobalSearchSuggestion(direction: 1 | -1): void {
    const suggestions = this.scopedGlobalSearchSuggestions();
    if (suggestions.length === 0) {
      return;
    }
    const next = (this.activeGlobalSearchSuggestionIndex() + direction + suggestions.length) % suggestions.length;
    this.activeGlobalSearchSuggestionIndex.set(next);
    this.globalSearchAutocompleteOpen.set(true);
  }

  activateGlobalSearchSuggestion(index: number): void {
    this.activeGlobalSearchSuggestionIndex.set(index);
  }

  public selectActiveGlobalSearchSuggestion(): void {
    const suggestion = this.scopedGlobalSearchSuggestions()[this.activeGlobalSearchSuggestionIndex()];
    if (suggestion) {
      this.selectGlobalSearchSuggestion(suggestion);
    }
  }

  selectGlobalSearchSuggestion(suggestion: GlobalSearchSuggestion): void {
    this.toggleAnalysisFilter(sectionIdForGlobalSearchKind(suggestion.kind), suggestion.id, !this.isGlobalSearchSuggestionSelected(suggestion));
  }

  toggleGlobalSearchSuggestionGroup(group: GlobalSearchSuggestionGroupView): void {
    for (const suggestion of group.suggestions) {
      this.toggleAnalysisFilter(sectionIdForGlobalSearchKind(suggestion.kind), suggestion.id, !group.allSelected);
    }
  }

  public toggleAllGlobalSearchSuggestions(): void {
    const selected = !this.allGlobalSearchSuggestionsSelected();
    for (const suggestion of this.scopedGlobalSearchSuggestions()) {
      this.toggleAnalysisFilter(sectionIdForGlobalSearchKind(suggestion.kind), suggestion.id, selected);
    }
  }

  async toggleGroupSkip(groupId: string): Promise<void> {
    const result = this.scanResult();
    if (!result || this.applying() || this.groupPlanLoading()[groupId]) {
      return;
    }

    const skippedGroups = this.skippedGroups();
    this.groupPlanLoading.set({ ...this.groupPlanLoading(), [groupId]: true });
    this.error.set(undefined);
    try {
      const response = skippedGroups[groupId]
        ? await this.api.restoreSkippedGroup(result.scanId, groupId)
        : await this.api.skipGroup(result.scanId, groupId);
      this.replaceAnalysisResult(response.scan);
      this.status.set(skippedGroups[groupId]
        ? "已取消跳过标记，该组重新纳入执行计划。"
        : "已标记跳过；该组不会纳入执行计划。");
    } catch (error) {
      this.error.set(messageFor(error));
    } finally {
      this.groupPlanLoading.set({ ...this.groupPlanLoading(), [groupId]: false });
    }
  }

  updateKeep(itemId: string, keep: boolean): void {
    const current = this.decisions()[itemId];
    if (!current) {
      return;
    }
    this.decisions.set({ ...this.decisions(), [itemId]: { ...current, keep } });
  }

  updateTargetVault(itemId: string, targetVaultId: string): void {
    const current = this.decisions()[itemId];
    if (!current) {
      return;
    }
    this.decisions.set({ ...this.decisions(), [itemId]: { ...current, targetVaultId } });
  }

  updateRemoveAction(itemId: string, removeAction: RemoveAction): void {
    const current = this.decisions()[itemId];
    if (!current) {
      return;
    }
    this.decisions.set({ ...this.decisions(), [itemId]: { ...current, deleteMode: removeAction } });
  }

  toggleTagRemoval(itemId: string, tag: string): void {
    const current = this.decisions()[itemId];
    if (!current) {
      return;
    }
    const removeTags = new Set(current.removeTags ?? []);
    if (removeTags.has(tag)) {
      removeTags.delete(tag);
    } else {
      removeTags.add(tag);
    }
    this.decisions.set({
      ...this.decisions(),
      [itemId]: { ...current, removeTags: Array.from(removeTags) }
    });
  }

  removeTagFromGroup(groupId: string, tag: string): void {
    const group = this.groups().find((candidate) => candidate.id === groupId);
    const result = this.scanResult();
    if (!group || !result) {
      return;
    }
    const itemById = new Map(result.items.map((item) => [item.id, item]));
    const next = { ...this.decisions() };
    for (const itemId of group.itemIds) {
      const current = next[itemId];
      const item = itemById.get(itemId);
      if (!current?.keep || !item?.tags.includes(tag)) {
        continue;
      }
      next[itemId] = {
        ...current,
        removeTags: Array.from(new Set([...(current.removeTags ?? []), tag]))
      };
    }
    this.decisions.set(next);
  }

  updateGroupRemoveAction(groupId: string, removeAction: RemoveAction): void {
    const group = this.groups().find((candidate) => candidate.id === groupId);
    if (!group) {
      return;
    }

    const next = { ...this.decisions() };
    for (const itemId of group.itemIds) {
      const current = next[itemId];
      if (current && !current.keep) {
        next[itemId] = { ...current, deleteMode: removeAction };
      }
    }
    this.decisions.set(next);
  }

  acceptAllRecommendations(): void {
    const result = this.scanResult();
    if (!result) {
      return;
    }
    this.decisions.set(this.defaultDecisions(result));
    this.skippedGroups.set({});
  }

  async toggleReveal(): Promise<void> {
    const reveal = !this.reveal();
    this.reveal.set(reveal);
    if (!reveal) {
      return;
    }

    const result = this.scanResult();
    if (!result) {
      return;
    }
    const credentials = { ...this.revealedCredentials() };
    const visibleItemIds = this.visibleGroups().flatMap((group) => group.items.map((item) => item.id));
    for (const itemId of visibleItemIds) {
      if (credentials[itemId]) {
        continue;
      }
      try {
        const response = await this.api.revealCredentials(result.scanId, itemId);
        credentials[itemId] = response.fields.length > 0
          ? response.fields
          : [{ label: '凭据', value: '无可显示凭据', fieldType: 'empty' }];
        this.revealedCredentials.set({ ...credentials });
      } catch {
        credentials[itemId] = [{ label: '凭据', value: '显示失败', fieldType: 'error' }];
        this.revealedCredentials.set({ ...credentials });
      }
    }
  }

  async toggleGroupReveal(groupId: string): Promise<void> {
    const group = this.visibleGroups().find((candidate) => candidate.id === groupId)
      ?? this.groupViews().find((candidate) => candidate.id === groupId);
    if (!group) {
      return;
    }

    const itemIds = group.items
      .filter((item) => item.credChips.some((chip) => chip.kind !== 'missing'))
      .map((item) => item.id);
    if (itemIds.length === 0) {
      return;
    }

    const visible = { ...this.visibleSecretItems() };
    const allVisible = itemIds.every((itemId) => visible[itemId]);
    for (const itemId of itemIds) {
      visible[itemId] = !allVisible;
    }
    this.visibleSecretItems.set(visible);
    if (allVisible) {
      return;
    }

    const result = this.scanResult();
    if (!result) {
      return;
    }

    for (const itemId of itemIds) {
      if (this.revealedCredentials()[itemId] || this.revealingItems()[itemId]) {
        continue;
      }
      this.revealingItems.set({ ...this.revealingItems(), [itemId]: true });
      try {
        const response = await this.api.revealCredentials(result.scanId, itemId);
        this.revealedCredentials.set({
          ...this.revealedCredentials(),
          [itemId]: response.fields.length > 0
            ? response.fields
            : [{ label: '凭据', value: '无可显示凭据', fieldType: 'empty' }]
        });
      } catch {
        this.revealedCredentials.set({
          ...this.revealedCredentials(),
          [itemId]: [{ label: '凭据', value: '显示失败', fieldType: 'error' }]
        });
      } finally {
        this.revealingItems.set({ ...this.revealingItems(), [itemId]: false });
      }
    }
  }

  groupOperationCount(groupId: string): number {
    const plan = this.localPlanForGroup(groupId);
    return plan?.actions.filter((action) => action.type !== 'keep').length ?? 0;
  }

  canApplyGroup(groupId: string): boolean {
    return this.groupOperationCount(groupId) > 0 &&
      !this.loading() &&
      !this.applying() &&
      !this.groupPlanLoading()[groupId];
  }

  openGroupExecutionDialog(groupId: string): void {
    if (!this.canApplyGroup(groupId)) {
      return;
    }
    const group = this.allPreviewGroups().find((candidate) => candidate.id === groupId);
    if (!group?.plan) {
      this.error.set('找不到待执行的重复组。');
      return;
    }
    this.prepareActionExecution([group], 'group');
  }

  applyPlan(): void {
    if (!this.canApply()) {
      return;
    }
    this.prepareActionExecution(this.visiblePreviewGroups(), 'plan');
  }

  async startPreparedActionExecution(): Promise<void> {
    const draft = this.preparedActionDraft();
    if (!draft || this.actionExecutionStatus() !== 'ready' || this.applying()) {
      return;
    }
    this.error.set(undefined);
    this.applying.set(true);
    this.actionExecutionStatus.set('starting');
    try {
      const hasDelete = draft.groups.some((group) => group.items.some((item) => !item.keep && item.deleteMode === 'delete'));
      const execution = await this.api.startActionExecution(
        draft,
        hasDelete ? deleteConfirmationPhrase : undefined,
        this.dryRunSpeedMultiplier(),
      );
      if (!execution.eventsToken) {
        throw new Error('执行任务缺少进度令牌。');
      }
      this.actionExecutionId.set(execution.executionId);
      this.actionExecutionStatus.set(execution.status);
      this.actionExecutionWriteEnabled.set(execution.writeEnabled);
      await this.api.streamActionExecutionEvents(execution.executionId, execution.eventsToken, (event) => this.applyActionExecutionEvent(event));
    } catch (error) {
      const executionError = messageFor(error);
      this.error.set(executionError);
      this.skipPendingOperations('执行未完成。');
      this.actionExecutionStatus.set('failed');
      if (isStaleAnalysisError(executionError)) {
        await this.recoverStaleAnalysis(executionError);
      }
    } finally {
      this.applying.set(false);
      this.preparedActionDraft.set(undefined);
      this.status.set(this.actionExecutionStatus() === 'failed'
        ? this.error() ?? '执行失败。'
        : this.actionExecutionWriteEnabled() ? this.summaryLine() : `试写完成，${this.summaryLine()}`);
    }
  }

  private prepareActionExecution(groups: PreviewGroupView[], scope: ActionExecutionScope): void {
    const operations = this.buildOperations(groups);
    if (operations.length === 0) {
      return;
    }
    this.operations.set(operations);
    this.operationGroupErrors.set({});
    this.preparedActionDraft.set(this.actionDraftForGroups(groups));
    this.error.set(undefined);
    this.applying.set(false);
    this.applyDialogOpen.set(true);
    this.actionExecutionId.set(undefined);
    this.actionExecutionStatus.set('ready');
    this.actionExecutionScope.set(scope);
    this.actionExecutionWriteEnabled.set(this.mutationsEnabled());
  }

  async pauseActionExecution(): Promise<void> {
    const executionId = this.actionExecutionId();
    if (!executionId || !this.applying()) {
      return;
    }
    const snapshot = await this.api.pauseActionExecution(executionId);
    this.actionExecutionStatus.set(snapshot.status);
  }

  async resumeActionExecution(): Promise<void> {
    const executionId = this.actionExecutionId();
    if (!executionId || this.actionExecutionStatus() !== 'paused') {
      return;
    }
    const snapshot = await this.api.resumeActionExecution(executionId);
    this.actionExecutionStatus.set(snapshot.status);
  }

  async stopActionExecution(): Promise<void> {
    const executionId = this.actionExecutionId();
    if (!executionId || !this.applying()) {
      return;
    }
    const snapshot = await this.api.stopActionExecution(executionId);
    if (!['stopped', 'completed', 'failed'].includes(this.actionExecutionStatus() ?? '')) {
      this.actionExecutionStatus.set(snapshot.status);
    }
  }

  closeApplyDialog(): void {
    if (!this.canCloseApplyDialog()) {
      return;
    }
    this.applyDialogOpen.set(false);
    if (this.actionExecutionStatus() === 'ready') {
      this.preparedActionDraft.set(undefined);
      this.actionExecutionStatus.set(undefined);
      this.operations.set([]);
    }
  }

  openApplyDialog(): void {
    this.applyDialogOpen.set(true);
  }

  async resetAll(): Promise<void> {
    await this.rescan();
  }

  itemById(itemId: string): ItemSummary | undefined {
    return this.scanResult()?.items.find((item) => item.id === itemId);
  }

  private restoreScanSnapshot(scan: ScanSnapshot): void {
    this.scanSnapshot.set(scan);
    this.scanProgress.set({
      scanId: scan.scanId,
      phase: 'completed',
      startedAt: scan.scannedAt,
      finishedAt: new Date(Date.parse(scan.scannedAt) + (scan.durationMs ?? 0)).toISOString(),
      totalVaults: scan.vaults.length,
      scannedVaults: scan.vaults.length,
      totalItems: scan.items.length,
      scannedItems: scan.items.length,
      vaults: summarizeVaults(scan.vaults, scan.items),
      message: '已恢复本地扫描缓存。'
    });
    this.authState.set('authorized');
    this.error.set(undefined);
    this.status.set('已恢复本地扫描缓存。');
  }

  private restoreAnalysisResult(result: AnalysisResultResponse): void {
    this.scanResult.set(result);
    this.restoreScanSnapshot({
      scanId: result.scanId,
      scannedAt: result.scannedAt,
      durationMs: result.durationMs,
      vaults: result.vaults,
      items: result.items
    });
    this.decisions.set(this.defaultDecisions(result));
    this.skippedGroups.set(skippedGroupMap(result.skippedGroupIds));
    this.visibleSecretItems.set({});
    this.revealingItems.set({});
    this.revealedCredentials.set({});
    this.reveal.set(false);
    this.clearAnalysisFilters();
    this.status.set(result.groups.length ? `已恢复本 tab 的分析缓存，剩余 ${result.groups.length} 组疑似重复。` : '已恢复本 tab 的分析缓存，没有剩余疑似重复。');
  }

  private replaceAnalysisResult(result: AnalysisResultResponse): void {
    this.scanResult.set(result);
    this.scanSnapshot.set({
      scanId: result.scanId,
      scannedAt: result.scannedAt,
      durationMs: result.durationMs,
      vaults: result.vaults,
      items: result.items
    });
    this.skippedGroups.set(skippedGroupMap(result.skippedGroupIds));
  }

  private localPlanForGroup(groupId: string): ActionPlanGroup | undefined {
    const group = this.groups().find((candidate) => candidate.id === groupId);
    const result = this.scanResult();
    if (!group || !result || this.skippedGroups()[group.id]) {
      return undefined;
    }
    return this.createLocalPlan(group, result.items);
  }

  private clearGlobalSearch(): void {
    this.globalSearchRequestId += 1;
    this.globalSearchQuery.set('');
    this.globalSearchItemIds.set(undefined);
    this.globalSearchSuggestions.set([]);
    this.globalSearchAutocompleteOpen.set(false);
    this.activeGlobalSearchSuggestionIndex.set(0);
  }

  private resetForScan(): void {
    this.authState.set('idle');
    this.scanProgress.set(undefined);
    this.scanSnapshot.set(undefined);
    this.scanResult.set(undefined);
    this.loading.set(false);
    this.analyzing.set(false);
    this.analysisPct.set(0);
    this.error.set(undefined);
    this.status.set(undefined);
    this.decisions.set({});
    this.skippedGroups.set({});
    this.reveal.set(false);
    this.visibleSecretItems.set({});
    this.revealingItems.set({});
    this.revealedCredentials.set({});
    this.analysisFilters.set(emptyAnalysisFilters());
    this.filterSectionsOpen.set({ ...defaultFilterSectionsOpen });
    this.clearGlobalSearch();
    this.operations.set([]);
    this.operationGroupErrors.set({});
    this.applying.set(false);
    this.preparedActionDraft.set(undefined);
    this.actionExecutionStatus.set(undefined);
    this.applyDialogOpen.set(false);
    this.groupPlanLoading.set({});
  }

  private defaultDecisions(result: ScanResult): Record<string, ActionDraftItem> {
    const decisions: Record<string, ActionDraftItem> = {};
    for (const group of result.groups) {
      const recommended = new Set(group.recommendedKeepIds);
      const items = group.itemIds
        .map((id) => result.items.find((item) => item.id === id))
        .filter((item): item is ItemSummary => Boolean(item));
      const fallbackKeepId = items.slice().sort((a, b) => itemUpdatedDate(b).localeCompare(itemUpdatedDate(a)))[0]?.id;
      for (const item of items) {
        const keep = recommended.size > 0
          ? recommended.has(item.id)
          : item.id === fallbackKeepId;
        decisions[item.id] = {
          itemId: item.id,
          keep,
          targetVaultId: item.vaultId,
          deleteMode: 'archive',
          removeTags: []
        };
      }
    }
    return decisions;
  }

  private async recoverStaleAnalysis(originalError: string): Promise<void> {
    try {
      const previousDecisions = this.decisions();
      const result = await this.api.loadAnalysis();
      const defaults = this.defaultDecisions(result);
      const vaultIds = new Set(result.vaults.map((vault) => vault.id));
      const decisions = Object.fromEntries(Object.entries(defaults).map(([itemId, fallback]) => {
        const previous = previousDecisions[itemId];
        if (!previous) {
          return [itemId, fallback];
        }
        return [itemId, {
          ...previous,
          itemId,
          targetVaultId: previous.targetVaultId && vaultIds.has(previous.targetVaultId)
            ? previous.targetVaultId
            : fallback.targetVaultId,
          removeTags: [...(previous.removeTags ?? [])]
        } satisfies ActionDraftItem];
      }));
      this.replaceAnalysisResult(result);
      this.decisions.set(decisions);
      this.error.set('执行未开始：分析结果已自动同步，未执行 item 的处置意图已保留。请重新点击应用计划。');
    } catch (recoveryError) {
      this.error.set(`${originalError}\n自动同步失败：${messageFor(recoveryError)}`);
    }
  }

  private buildScanRows(): ScanVaultRow[] {
    const progress = this.scanProgress();
    const data = this.scanData();
    const vaults = progress?.vaults.length
      ? progress.vaults
      : data
        ? summarizeScanVaults(data.vaults, data.items)
        : [];
    return vaults.map((vault, index) => this.toScanVaultRow(vault, index));
  }

  private toScanVaultRow(vault: VaultScanSummary, index: number): ScanVaultRow {
    const total = vault.itemCount;
    const scanned = this.scannedItemsForVault(vault);
    const pct = total ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
    const done = this.scanDone() || (total > 0 && scanned >= total);
    const started = scanned > 0 || this.authState() === 'authorized';
    return {
      id: vault.id,
      iconIndex: index,
      name: `${vault.name} vault`,
      scanned,
      total,
      pct,
      started,
      status: done ? '完成' : started ? '扫描中…' : '等待中',
      statusColor: done ? '#c3e88d' : started ? '#82aaff' : '#727272',
      barColor: done ? '#c3e88d' : '#82aaff',
      typeRows: typeRowsForVault(vault)
    };
  }

  private scannedItemsForVault(vault: VaultScanSummary): number {
    const counted = Object.values(vault.categoryCounts).reduce((total, count) => total + count, 0);
    if (this.scanDone()) {
      return vault.itemCount;
    }
    return Math.min(vault.itemCount, counted);
  }

  private buildGroupViews(): DuplicateGroupView[] {
    const result = this.scanResult();
    if (!result) {
      return [];
    }
    const itemById = new Map(result.items.map((item) => [item.id, item]));
    return this.groups()
      .map((group) => this.toGroupView(group, itemById, result.vaults));
  }

  private filterGroups(groups: DuplicateGroupView[]): DuplicateGroupView[] {
    const filters = this.analysisFilters();
    const result = this.scanResult();
    if (!result) {
      return [];
    }

    const hasStructuredFilters = filters.years.length > 0 || filters.vaultIds.length > 0 || filters.domains.length > 0;
    const structuredItemIds = new Set(result.items
      .filter((item) => hasStructuredFilters && itemMatchesStructuredFilters(item, filters))
      .map((item) => item.id));
    const fieldItemIds = new Set(this.globalSearchItemIds() ?? []);
    const searchActive = hasStructuredFilters || this.globalSearchQuery().trim().length > 0;

    return groups.filter((group) =>
      matchesSelected(filters.credentialKinds, group.filterCredentialKinds)
      && (!searchActive || group.items.some((item) => structuredItemIds.has(item.id) || fieldItemIds.has(item.id)))
    );
  }

  private buildAnalysisFilterSections(): AnalysisFilterSectionView[] {
    const groups = this.groupViews();
    const filters = this.analysisFilters();
    const open = this.filterSectionsOpen();
    const optionData = {
      years: yearOptions(groups),
      vaults: vaultOptions(groups),
      domains: domainOptions(groups),
      credentials: credentialOptions(groups)
    };

    return (Object.keys(filterSectionMeta) as AnalysisFilterSectionId[]).map((id) => {
      const meta = filterSectionMeta[id];
      const selected = selectedFilterValues(filters, id);
      const rawOptions = optionData[id];
      return {
        id,
        label: meta.label,
        countLabel: selected.length ? `${selected.length} / ${rawOptions.length}` : `${rawOptions.length}`,
        expanded: open[id],
        emptyText: meta.emptyText,
        options: rawOptions.map((option) => ({
          ...option,
          selected: selected.includes(option.id)
        }))
      };
    });
  }

  private buildAnalysisFilterSummary(): AnalysisFilterSummaryView {
    const groups = this.groupViews();
    const filters = this.analysisFilters();
    const labels = {
      years: optionLabelMap(yearOptions(groups)),
      vaultIds: optionLabelMap(vaultOptions(groups)),
      domains: optionLabelMap(domainOptions(groups)),
      credentialKinds: optionLabelMap(credentialOptions(groups))
    };
    const search = this.globalSearchQuery().trim();
    const chips: AnalysisFilterChipView[] = [
      ...(search ? [{ key: 'search' as const, id: search, label: `搜索：${search}` }] : []),
      ...filters.years.map((id) => ({ key: 'year' as const, id, label: labels.years.get(id) ?? id })),
      ...filters.vaultIds.map((id) => ({ key: 'vault' as const, id, label: labels.vaultIds.get(id) ?? id })),
      ...filters.domains.map((id) => ({ key: 'domain' as const, id, label: labels.domains.get(id) ?? id })),
      ...filters.credentialKinds.map((id) => ({ key: 'credential' as const, id, label: labels.credentialKinds.get(id) ?? id }))
    ];

    return {
      total: groups.length,
      visible: this.visibleGroups().length,
      activeCount: chips.length,
      chips
    };
  }

  private buildGlobalSearchSuggestionGroups(): GlobalSearchSuggestionGroupView[] {
    const suggestions = this.scopedGlobalSearchSuggestions();
    return (Object.keys(globalSearchSuggestionKindLabels) as GlobalSearchSuggestionKind[])
      .map((kind) => {
        const groupSuggestions = suggestions
          .filter((suggestion) => suggestion.kind === kind)
          .map((suggestion) => ({
            ...suggestion,
            index: suggestions.findIndex((candidate) => candidate.id === suggestion.id),
            selected: this.isGlobalSearchSuggestionSelected(suggestion),
            detail: `${suggestion.count} 个相似组`,
          }));
        const selectedCount = groupSuggestions.filter((suggestion) => suggestion.selected).length;
        return {
          kind,
          label: globalSearchSuggestionKindLabels[kind],
          allSelected: groupSuggestions.length > 0 && selectedCount === groupSuggestions.length,
          someSelected: selectedCount > 0 && selectedCount < groupSuggestions.length,
          suggestions: groupSuggestions,
        };
      })
      .filter((group) => group.suggestions.length > 0);
  }

  private selectedGlobalSearchSuggestions(): GlobalSearchSuggestion[] {
    return this.scopedGlobalSearchSuggestions().filter((suggestion) => this.isGlobalSearchSuggestionSelected(suggestion));
  }

  private isGlobalSearchSuggestionSelected(suggestion: GlobalSearchSuggestion): boolean {
    const filters = this.analysisFilters();
    return selectedFilterValues(filters, sectionIdForGlobalSearchKind(suggestion.kind)).includes(suggestion.id);
  }

  private scopedGlobalSearchSuggestions(): GlobalSearchSuggestion[] {
    return this.globalSearchSuggestions();
  }

  private searchFilterOptions(keywords: string[]): GlobalSearchSuggestion[] {
    if (keywords.length === 0) {
      return [];
    }
    const groups = this.groupViews();
    const optionGroups: Array<{ kind: GlobalSearchSuggestionKind; options: AnalysisFilterOptionData[] }> = [
      { kind: "year", options: yearOptions(groups) },
      { kind: "vault", options: vaultOptions(groups) },
      { kind: "domain", options: domainOptions(groups) },
    ];
    return optionGroups.flatMap(({ kind, options }) => options
      .filter((option) => keywords.some((keyword) => normalizeLooseText(option.label).includes(keyword)))
      .slice(0, 8)
      .map((option) => ({ ...option, kind })));
  }

  private toGroupView(group: SimilarityGroup, itemById: Map<string, ItemSummary>, vaults: VaultSummary[]): DuplicateGroupView {
    const items = group.itemIds.map((id) => itemById.get(id)).filter((item): item is ItemSummary => Boolean(item));
    const skipped = Boolean(this.skippedGroups()[group.id]);
    return {
      id: group.id,
      site: groupSite(items),
      username: groupUsername(items),
      count: items.length,
      skipped,
      opacity: skipped ? 0.45 : 1,
      cardBorder: skipped ? '#3a3a3a' : '#3F3F3F',
      skipLabel: skipped ? '恢复此组' : '跳过此组',
      skipColor: skipped ? '#82aaff' : '#c792ea',
      filterYears: groupYears(items),
      filterVaultIds: uniqueSortedStrings(items.map((item) => item.vaultId).filter(Boolean)),
      filterDomains: groupDomains(items),
      filterCredentialKinds: groupCredentialKinds(items),
      items: items.map((item) => this.toItemView(group, item, vaults, skipped))
    };
  }

  private toItemView(group: SimilarityGroup, item: ItemSummary, vaults: VaultSummary[], skipped: boolean): DuplicateItemView {
    const decision = this.decisions()[item.id] ?? {
      itemId: item.id,
      keep: false,
      targetVaultId: item.vaultId,
      deleteMode: 'archive',
      removeTags: []
    };
    const removeAction = removeActionFromDecision(decision);
    const username = item.usernames.find(Boolean) ?? '（无 username）';
    const url = item.urls[0] || '—';
    const credChips = credentialChips(item, Boolean(this.visibleSecretItems()[item.id]), this.revealedCredentials()[item.id]);
    return {
      id: item.id,
      title: item.title,
      username,
      url,
      category: item.category,
      categoryLabel: categoryDisplay[item.category]?.label ?? item.category,
      updated: itemUpdatedDate(item),
      vaultId: item.vaultId,
      vaultName: item.vaultName,
      keep: decision.keep,
      notKeep: !decision.keep,
      targetVault: decision.targetVaultId || item.vaultId,
      removeAction,
      rowBg: decision.keep && !skipped ? 'rgba(130,170,255,0.04)' : 'transparent',
      secretVisible: Boolean(this.visibleSecretItems()[item.id]),
      credentialSignature: credentialCompareValue(item),
      credChips,
      tags: item.tags,
      removedTags: decision.removeTags ?? [],
      remainingTagCount: item.tags.filter((tag) => !(decision.removeTags ?? []).includes(tag)).length,
      detailRows: itemDetailRows(item),
      vaultOptions: vaults.map((vault) => ({
        id: vault.id,
        label: vault.id === item.vaultId ? `${vault.name}（原）` : `迁移至 ${vault.name}`,
        name: vault.name,
        current: vault.id === item.vaultId
      }))
    };
  }

  private buildDecisionStats(): DecisionStatsView {
    const result = this.scanResult();
    if (!result) {
      return { groups: 0, keep: 0, archive: 0, delete: 0, move: 0, skipped: 0 };
    }
    const itemById = new Map(result.items.map((item) => [item.id, item]));
    const stats = { groups: 0, keep: 0, archive: 0, delete: 0, move: 0, skipped: 0 };
    for (const group of this.groups()) {
      if (this.skippedGroups()[group.id]) {
        stats.skipped += 1;
        continue;
      }
      stats.groups += 1;
      for (const itemId of group.itemIds) {
        const item = itemById.get(itemId);
        const decision = this.decisions()[itemId];
        if (!item || !decision) {
          continue;
        }
        if (decision.keep) {
          stats.keep += 1;
          if ((decision.targetVaultId || item.vaultId) !== item.vaultId) {
            stats.move += 1;
          }
        } else if (decision.deleteMode === 'delete') {
          stats.delete += 1;
        } else {
          stats.archive += 1;
        }
      }
    }
    return stats;
  }

  private buildPreviewGroups(): PreviewGroupView[] {
    const result = this.scanResult();
    if (!result) {
      return [];
    }
    const itemById = new Map(result.items.map((item) => [item.id, item]));
    const previewGroups: PreviewGroupView[] = this.groups()
      .map((group) => {
        const groupView = this.toGroupView(group, itemById, result.vaults);
        if (groupView.skipped) {
          return {
            ...groupView,
            id: group.id,
            plan: undefined,
            actions: [this.skippedGroupPreviewRow(
              group,
              group.itemIds.map((itemId) => itemById.get(itemId)).filter((item): item is ItemSummary => Boolean(item))
            )]
          };
        }
        const plan = this.createLocalPlan(group, result.items);
        return {
          ...groupView,
          id: group.id,
          plan,
          actions: this.planActionPreviewRows(plan)
        };
      })
      .filter((group) => group.skipped || (group.actions.length > 0 && group.plan && group.plan.actions.some((action) => action.type !== 'keep')));
    return previewGroups;
  }

  private skippedGroupPreviewRow(group: SimilarityGroup, items: ItemSummary[]): PlanActionPreviewView {
    return {
      id: `skip:${group.id}`,
      itemId: group.id,
      title: `本组 ${items.length} 个项目`,
      username: "",
      url: "",
      created: "",
      updated: "",
      vaultName: "",
      opLabel: "跳过",
      targetLabel: "",
      detail: "",
      tone: "skip",
      removedTags: [],
      retainedTags: [],
      color: "#78909C",
      bg: "rgba(120, 144, 156, 0.1)",
      border: "rgba(120, 144, 156, 0.32)"
    };
  }

  private countPlanOperations(groups: PreviewGroupView[]): number {
    return groups.reduce((total, group) => {
      const actions = group.plan?.actions ?? [];
      return total + actions.filter((action) => action.type !== 'keep').length;
    }, 0);
  }

  private createLocalPlan(group: SimilarityGroup, items: ItemSummary[]): ActionPlanGroup {
    return createActionPlanGroup(group.id, this.groupDecision(group, items), items);
  }

  private planActionPreviewRows(plan: ActionPlanGroup): PlanActionPreviewView[] {
    const result = this.scanResult();
    if (!result) {
      return [];
    }
    const itemById = new Map(result.items.map((item) => [item.id, item]));
    return plan.actions.map((action) => describePlanAction(action, itemById.get(action.itemId), result.vaults));
  }

  private groupDecision(group: SimilarityGroup, items: ItemSummary[]): GroupDecision {
    const itemById = new Map(items.map((item) => [item.id, item]));
    return {
      scanId: this.scanResult()?.scanId ?? '',
      groupId: group.id,
      items: group.itemIds.map((itemId) => {
        const item = itemById.get(itemId);
        const decision = this.decisions()[itemId];
        return {
          itemId,
          keep: decision?.keep ?? false,
          targetVaultId: decision?.targetVaultId || item?.vaultId,
          deleteMode: decision?.deleteMode ?? 'archive',
          removeTags: decision?.removeTags ?? []
        };
      })
    };
  }

  private groupDecisionById(groupId: string): GroupDecision | undefined {
    const result = this.scanResult();
    const group = this.groups().find((candidate) => candidate.id === groupId);
    if (!result || !group) {
      return undefined;
    }
    return this.groupDecision(group, result.items);
  }

  private buildOperations(groups: PreviewGroupView[]): ApplyOperationView[] {
    return groups.flatMap((group) => {
      const plan = group.plan;
      if (!plan) {
        return [];
      }
      return plan.actions
        .filter((action) => action.type !== 'keep')
        .map((action) => this.toApplyOperation(group, action));
    });
  }

  private actionDraftForGroups(groups: PreviewGroupView[]): ActionDraft {
    const scanId = this.scanResult()?.scanId ?? '';
    return {
      scanId,
      groups: groups.map((group) => {
        const draft = this.groupDecisionById(group.id);
        if (!draft) {
          throw new Error(`找不到待执行的重复组：${ group.id }`);
        }
        return { groupId: draft.groupId, items: draft.items };
      }),
    };
  }

  private applyActionExecutionEvent(event: ActionExecutionEvent): void {
    this.actionExecutionStatus.set(event.status);
    if (event.type === 'action-started' && event.action && event.groupId) {
      this.operations.set(this.operations().map((operation) =>
        operation.groupId === event.groupId && operation.itemId === event.action?.itemId && operation.sourceAction === event.action.type
          ? { ...operation, status: 'running' as ApplyStatus }
          : operation
      ));
    } else if ((event.type === 'action-completed' || event.type === 'action-failed') && event.result && event.groupId) {
      const result = event.result;
      this.operations.set(this.operations().map((operation) => {
        if (operation.groupId !== event.groupId || operation.itemId !== result.itemId || operation.sourceAction !== result.action) {
          return operation;
        }
        if (result.skipped) {
          return { ...operation, status: 'skipped' as ApplyStatus, error: result.error };
        }
        return {
          ...operation,
          status: result.ok ? ('done' as ApplyStatus) : ('failed' as ApplyStatus),
          dryRun: !event.writeEnabled,
          error: result.error
        };
      }));
    }
    if (event.type === 'analysis-updated' && event.response && event.writeEnabled) {
      this.removeCompletedGroups(event.response.completedGroupIds);
    }
    if (event.type === 'stopped' || event.type === 'failed') {
      this.skipPendingOperations(event.type === 'stopped' ? '执行已停止。' : '执行失败，未继续处理。');
    }
    if (event.type === 'failed') {
      this.error.set(event.error ?? '执行失败。');
      if (event.groupId) {
        this.operationGroupErrors.set({ ...this.operationGroupErrors(), [event.groupId]: event.error ?? '执行失败。' });
      }
    }
  }

  private removeCompletedGroups(completedGroupIds: string[]): void {
    if (completedGroupIds.length === 0) {
      return;
    }
    const result = this.scanResult();
    if (!result) {
      return;
    }
    const completed = new Set(completedGroupIds);
    const groups = result.groups.filter((group) => !completed.has(group.id));
    const remainingItemIds = new Set(groups.flatMap((group) => group.itemIds));
    this.scanResult.set({ ...result, groups });
    this.decisions.set(Object.fromEntries(
      Object.entries(this.decisions()).filter(([itemId]) => remainingItemIds.has(itemId))
    ));
  }

  private toApplyOperation(group: PreviewGroupView, action: Exclude<PlanAction, { type: 'keep' }>): ApplyOperationView {
    const item = this.itemById(action.itemId);
    const title = item?.title || action.itemId;
    const groupLabel = `${group.username} @ ${group.site}`;
    if (action.type === 'copy-to-vault-and-archive-source') {
      const targetName = vaultName(this.scanResult()?.vaults ?? [], action.targetVaultId);
      return {
        id: `op-${group.id}-${action.type}-${action.itemId}`,
        groupId: group.id,
        groupLabel,
        itemId: action.itemId,
        type: 'move',
        sourceAction: action.type,
        label: `迁移「${title}」：${item?.vaultName ?? action.vaultId} → ${targetName}${action.removeTags.length > 0 ? `，同时${removedTagsLabel(action.removeTags)}` : ''}`,
        status: 'pending'
      };
    }
    if (action.type === 'update-tags') {
      return {
        id: `op-${group.id}-${action.type}-${action.itemId}`,
        groupId: group.id,
        groupLabel,
        itemId: action.itemId,
        type: 'tags',
        sourceAction: action.type,
        label: `更新「${title}」：${removedTagsLabel(action.removeTags)}`,
        status: 'pending'
      };
    }
    return {
      id: `op-${group.id}-${action.type}-${action.itemId}`,
      groupId: group.id,
      groupLabel,
      itemId: action.itemId,
      type: action.type,
      sourceAction: action.type,
      label: `${action.type === 'delete' ? '删除' : '归档'}「${title}」（${item?.vaultName ?? action.vaultId}）`,
      status: 'pending'
    };
  }

  private skipPendingOperations(error = '前序操作失败，已跳过。'): void {
    this.operations.set(this.operations().map((operation) => operation.status === 'pending' ? { ...operation, status: 'skipped', error } : operation));
  }
}

function emptyAnalysisFilters(): AnalysisFilterState {
  return {
    years: [],
    vaultIds: [],
    domains: [],
    credentialKinds: []
  };
}

function sectionIdForFilterKey(key: AnalysisFilterKey): AnalysisFilterSectionId {
  switch (key) {
    case 'year':
      return 'years';
    case 'vault':
      return 'vaults';
    case 'domain':
      return 'domains';
    case 'credential':
      return 'credentials';
    case 'search':
      throw new Error('全局搜索不属于分类筛选。');
  }
}

function selectedFilterValues(filters: AnalysisFilterState, sectionId: AnalysisFilterSectionId): string[] {
  switch (sectionId) {
    case 'years':
      return filters.years;
    case 'vaults':
      return filters.vaultIds;
    case 'domains':
      return filters.domains;
    case 'credentials':
      return filters.credentialKinds;
  }
}

function sectionIdForGlobalSearchKind(kind: GlobalSearchSuggestionKind): AnalysisFilterSectionId {
  switch (kind) {
    case "year":
      return "years";
    case "vault":
      return "vaults";
    case "domain":
      return "domains";
  }
}

function itemMatchesStructuredFilters(item: ItemSummary, filters: AnalysisFilterState): boolean {
  const year = item.updatedAt ? String(new Date(item.updatedAt).getUTCFullYear()) : missingYearId;
  const domains = item.urls
    .map((url) => normalizeUrlHost(url))
    .filter((domain): domain is string => Boolean(domain));
  return matchesSelected(filters.years, [year])
    && matchesSelected(filters.vaultIds, [item.vaultId])
    && matchesSelected(filters.domains, domains);
}

function matchesSelected<T extends string>(selected: T[], values: T[]): boolean {
  return selected.length === 0 || selected.some((value) => values.includes(value));
}

function toggleStringValue(values: string[], value: string, selected: boolean): string[] {
  return selected
    ? uniqueSortedStrings([...values, value])
    : values.filter((candidate) => candidate !== value);
}

function toggleCredentialKind(values: FilterCredentialKind[], value: FilterCredentialKind, selected: boolean): FilterCredentialKind[] {
  return selected
    ? groupCredentialKindsFromValues([...values, value])
    : values.filter((candidate) => candidate !== value);
}

function isFilterCredentialKind(value: string): value is FilterCredentialKind {
  return value === 'password' || value === 'totp' || value === 'passkey';
}

function groupYears(items: ItemSummary[]): string[] {
  return uniqueSortedStrings(items.map((item) => itemYearId(item)));
}

function itemYearId(item: ItemSummary): string {
  if (!item.updatedAt) {
    return missingYearId;
  }
  const timestamp = Date.parse(item.updatedAt);
  if (!Number.isFinite(timestamp)) {
    return missingYearId;
  }
  return String(new Date(timestamp).getUTCFullYear());
}

function groupDomains(items: ItemSummary[]): string[] {
  return uniqueSortedStrings(items.flatMap((item) =>
    item.urls.map((url) => normalizeUrlHost(url)).filter((domain): domain is string => Boolean(domain))
  ));
}

function groupCredentialKinds(items: ItemSummary[]): FilterCredentialKind[] {
  const kinds = new Set<FilterCredentialKind>();
  for (const item of items) {
    if (item.hasPassword) {
      kinds.add('password');
    }
    if (item.hasTotp) {
      kinds.add('totp');
    }
    if (item.hasPasskey) {
      kinds.add('passkey');
    }
  }
  return groupCredentialKindsFromValues(Array.from(kinds));
}

function groupCredentialKindsFromValues(values: FilterCredentialKind[]): FilterCredentialKind[] {
  return Array.from(new Set(values)).sort((a, b) => credentialKindMeta[a].order - credentialKindMeta[b].order);
}

function yearOptions(groups: DuplicateGroupView[]): AnalysisFilterOptionData[] {
  return countGroupValues(groups, (group) => group.filterYears, (id) => id === missingYearId ? '未记录' : id)
    .sort((a, b) => {
      if (a.id === missingYearId) {
        return 1;
      }
      if (b.id === missingYearId) {
        return -1;
      }
      return b.label.localeCompare(a.label);
    });
}

function vaultOptions(groups: DuplicateGroupView[]): AnalysisFilterOptionData[] {
  const labels = new Map<string, string>();
  for (const group of groups) {
    for (const item of group.items) {
      labels.set(item.vaultId, item.vaultName);
    }
  }
  return countGroupValues(groups, (group) => group.filterVaultIds, (id) => labels.get(id) ?? id)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function domainOptions(groups: DuplicateGroupView[]): AnalysisFilterOptionData[] {
  return countGroupValues(groups, (group) => group.filterDomains, (id) => id)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function credentialOptions(groups: DuplicateGroupView[]): AnalysisFilterOptionData[] {
  return countGroupValues(groups, (group) => group.filterCredentialKinds, (id) => credentialKindMeta[id].label)
    .sort((a, b) => credentialKindMeta[a.id as FilterCredentialKind].order - credentialKindMeta[b.id as FilterCredentialKind].order);
}

function countGroupValues<T extends string>(
  groups: DuplicateGroupView[],
  selectValues: (group: DuplicateGroupView) => T[],
  labelFor: (id: T) => string
): AnalysisFilterOptionData[] {
  const counts = new Map<T, { label: string; count: number }>();
  for (const group of groups) {
    for (const id of uniqueSortedStrings(selectValues(group)) as T[]) {
      const current = counts.get(id);
      counts.set(id, {
        label: current?.label ?? labelFor(id),
        count: (current?.count ?? 0) + 1
      });
    }
  }
  return Array.from(counts, ([id, option]) => ({ id, label: option.label, count: option.count }));
}

function optionLabelMap(options: AnalysisFilterOptionData[]): Map<string, string> {
  return new Map(options.map((option) => [option.id, option.label]));
}

function uniqueSortedStrings(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function readStoredAccountName(): string | undefined {
  if (typeof localStorage === 'undefined') {
    return undefined;
  }
  return localStorage.getItem(accountNameStorageKey) ?? undefined;
}

function summarizeScanVaults(vaults: VaultSummary[], items: ItemSummary[]): VaultScanSummary[] {
  return vaults.map((vault) => {
    const vaultItems = items.filter((item) => item.vaultId === vault.id);
    const categoryCounts = dashboardCategoryDefinitions.reduce((counts, definition) => ({
      ...counts,
      [definition.id]: 0
    }), {} as Record<DashboardCategory, number>);
    for (const item of vaultItems) {
      const category = dashboardCategoryDefinitions.find((definition) => definition.categories.includes(item.category))?.id ?? 'other';
      categoryCounts[category] += 1;
    }
    return {
      id: vault.id,
      name: vault.name,
      itemCount: vaultItems.length,
      categoryCounts
    };
  });
}

function typeRowsForVault(vault: VaultScanSummary) {
  return Object.entries(vault.categoryCounts)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => ({
      category,
      name: categoryDisplay[category]?.label ?? category,
      count,
      final: count,
      order: categoryDisplay[category]?.order ?? 50,
      color: categoryChipColors[category] ?? '#82aaff',
      countColor: '#eeffff'
    }))
    .sort((a, b) => a.order - b.order)
    .slice(0, 6);
}

function groupUsername(items: ItemSummary[]): string {
  return items.flatMap((item) => item.usernames).find(Boolean) ?? '（无 username）';
}

function groupSite(items: ItemSummary[]): string {
  const url = items.flatMap((item) => item.urls).find(Boolean);
  if (!url) {
    return '—';
  }
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function credentialChips(item: ItemSummary, reveal: boolean, revealedFields: RevealedCredentialField[] | undefined): CredentialChipView[] {
  if (reveal && revealedFields) {
    return revealedFields.map((field) => credentialChip(
      field.label,
      credentialKind(field.label, field.fieldType),
      field.value,
      field.fieldType === 'error'
    ));
  }

  const chips = item.comparableFields
    .filter((field) => field.kind === 'secret')
    .map((field) => {
      const kind = credentialKind(field.label);
      return credentialChip(field.label, kind, reveal ? '读取中…' : maskedCredentialValue(kind));
    });

  if (item.hasPassword && !chips.some((chip) => chip.kind === 'password')) {
    chips.push(credentialChip('密码', 'password', reveal ? '读取中…' : '••••••••••'));
  }
  if (item.hasTotp && !chips.some((chip) => chip.kind === 'totp')) {
    chips.push(credentialChip('一次性密码', 'totp', reveal ? '读取中…' : '••••••'));
  }
  if (item.hasPasskey && !chips.some((chip) => chip.kind === 'passkey')) {
    chips.push(credentialChip('Passkey', 'passkey', '已创建'));
  }
  if (chips.length === 0) {
    chips.push(credentialChip('缺失', 'missing', '（无凭据）', true));
  }
  return chips;
}

function credentialKind(label: string, fieldType = ''): CredentialChipView['kind'] {
  const value = `${label} ${fieldType}`.toLowerCase();
  if (fieldType === 'error' || fieldType === 'empty') {
    return 'missing';
  }
  if (/totp|\botp\b|one.?time|一次性|验证码/.test(value)) {
    return 'totp';
  }
  if (/passkey|webauthn|sign.?in.?with/.test(value)) {
    return 'passkey';
  }
  if (/password|concealed|密码/.test(value)) {
    return 'password';
  }
  return 'secret';
}

function credentialChip(label: string, kind: CredentialChipView['kind'], text: string, error = false): CredentialChipView {
  const tones: Record<CredentialChipView['kind'], { bg: string; color: string }> = {
    password: { bg: 'rgba(130,170,255,0.12)', color: '#82aaff' },
    secret: { bg: 'rgba(199,146,234,0.12)', color: '#c792ea' },
    totp: { bg: 'rgba(255,203,107,0.14)', color: '#ffcb6b' },
    passkey: { bg: 'rgba(195,232,141,0.12)', color: '#c3e88d' },
    missing: { bg: 'rgba(255,83,112,0.14)', color: '#ff5370' }
  };
  const tone = tones[kind];
  return {
    kind,
    label: displayCredentialLabel(label, kind),
    bg: tone.bg,
    color: tone.color,
    text,
    textColor: error ? '#ff5370' : '#B0BEC5'
  };
}

function displayCredentialLabel(label: string, kind: CredentialChipView['kind']): string {
  const normalized = label.trim().toLowerCase();
  if (!normalized || normalized === 'credential') {
    return kind === 'secret' ? '密钥' : '凭据';
  }
  if (normalized === 'password') {
    return '密码';
  }
  return label;
}

function maskedCredentialValue(kind: CredentialChipView['kind']): string {
  if (kind === 'passkey') {
    return '已创建';
  }
  return kind === 'totp' ? '••••••' : '••••••••••';
}

function credentialCompareValue(item: ItemSummary): string {
  const secretHashes = item.comparableFields
    .filter((field) => field.kind === 'secret' && field.normalizedValueHash)
    .map((field) => `${normalizeLooseText(field.label)}:${field.normalizedValueHash}`)
    .sort();
  return [
    `password:${item.hasPassword ? '1' : '0'}`,
    `totp:${item.hasTotp ? '1' : '0'}`,
    `passkey:${item.hasPasskey ? '1' : '0'}`,
    ...secretHashes
  ].join('\u0000');
}

function describePlanAction(action: PlanAction, item: ItemSummary | undefined, vaults: VaultSummary[]): PlanActionPreviewView {
  const title = item?.title || action.itemId;
  const username = item?.usernames.find(Boolean) ?? '（无 username）';
  const url = item?.urls[0] || '—';
  const created = item?.createdAt ? item.createdAt.slice(0, 10) : '—';
  const updated = item ? itemUpdatedDate(item) : '-';
  const vault = item?.vaultName || vaultName(vaults, action.vaultId);
  const removedTags = 'removeTags' in action ? action.removeTags : [];
  const retainedTags = item?.tags.filter((tag) => !removedTags.includes(tag)) ?? [];
  if (action.type === 'update-tags') {
    return {
      id: `${action.type}:${action.itemId}`,
      itemId: action.itemId,
      title,
      username,
      url,
      created,
      updated,
      vaultName: vault,
      opLabel: '标签',
      targetLabel: `移除 ${removedTags.length} 个`,
      detail: `保留在 ${vault}，更新标签`,
      tone: 'tags',
      removedTags,
      retainedTags,
      color: '#c792ea',
      bg: 'rgba(199,146,234,0.1)',
      border: 'rgba(199,146,234,0.38)'
    };
  }
  if (action.type === 'keep') {
    const targetVaultName = vaultName(vaults, action.targetVaultId);
    const moved = action.targetVaultId !== action.vaultId;
    return {
      id: `${action.type}:${action.itemId}`,
      itemId: action.itemId,
      title,
      username,
      url,
      created,
      updated,
      vaultName: vault,
      opLabel: moved ? '迁移保留' : '保留',
      targetLabel: moved ? targetVaultName : vault,
      detail: moved ? `保留并迁移至 ${targetVaultName}` : `保留在 ${vault}`,
      tone: moved ? 'move' : 'keep',
      removedTags,
      retainedTags,
      color: moved ? '#82aaff' : '#c3e88d',
      bg: moved ? 'rgba(130,170,255,0.1)' : 'rgba(195,232,141,0.08)',
      border: moved ? 'rgba(130,170,255,0.36)' : 'rgba(195,232,141,0.32)'
    };
  }
  if (action.type === 'copy-to-vault-and-archive-source') {
    const targetVaultName = vaultName(vaults, action.targetVaultId);
    return {
      id: `${action.type}:${action.itemId}`,
      itemId: action.itemId,
      title,
      username,
      url,
      created,
      updated,
      vaultName: vault,
      opLabel: '迁移',
      targetLabel: targetVaultName,
      detail: `复制到 ${targetVaultName}，成功后归档原 item`,
      tone: 'move',
      removedTags,
      retainedTags,
      color: '#82aaff',
      bg: 'rgba(130,170,255,0.1)',
      border: 'rgba(130,170,255,0.36)'
    };
  }
  if (action.type === 'delete') {
    return {
      id: `${action.type}:${action.itemId}`,
      itemId: action.itemId,
      title,
      username,
      url,
      created,
      updated,
      vaultName: vault,
      opLabel: '删除',
      targetLabel: '永久删除',
      detail: '从 1Password 永久删除，不进入归档',
      tone: 'delete',
      removedTags,
      retainedTags,
      color: '#ff5370',
      bg: 'rgba(255,83,112,0.1)',
      border: 'rgba(255,83,112,0.42)'
    };
  }
  return {
    id: `${action.type}:${action.itemId}`,
    itemId: action.itemId,
    title,
    username,
    url,
    created,
    updated,
    vaultName: vault,
    opLabel: '归档',
    targetLabel: '归档',
    detail: '移动到 1Password 归档，可恢复',
    tone: 'archive',
    removedTags,
    retainedTags,
    color: '#ffcb6b',
    bg: 'rgba(255,203,107,0.09)',
    border: 'rgba(255,203,107,0.34)'
  };
}

function removedTagsLabel(tags: string[]): string {
  return `移除标签${tags.map((tag) => `「${tag}」`).join('、')}`;
}

function itemDetailRows(item: ItemSummary): Array<{ key: 'updated' | 'created' | 'tags'; label: string; value: string }> {
  const rows: Array<{ key: 'updated' | 'created' | 'tags'; label: string; value: string }> = [
    { key: 'updated', label: '更新时间', value: itemUpdatedDate(item) },
    { key: 'created', label: '创建时间', value: item.createdAt ? item.createdAt.slice(0, 10) : '—' }
  ];
  if (item.tags.length > 0) {
    rows.push({ key: 'tags', label: '标签', value: item.tags.join(', ') });
  }
  return rows;
}

function vaultName(vaults: VaultSummary[], vaultId: string): string {
  return vaults.find((vault) => vault.id === vaultId)?.name ?? vaultId;
}

function skippedGroupMap(groupIds: string[]): Record<string, boolean> {
  return Object.fromEntries(groupIds.map((groupId) => [groupId, true]));
}

function toOperationRow(operation: ApplyOperationView): ApplyOperationRowView {
  const statusText = operation.status === 'done'
    ? operation.dryRun ? '已试写' : '成功'
    : operation.status === 'failed'
      ? '失败'
      : operation.status === 'running'
        ? '执行中…'
        : operation.status === 'skipped'
          ? '已跳过'
          : '等待';
  return {
    ...operation,
    icon: operation.status === 'done' ? '✓' : operation.status === 'failed' ? '✕' : operation.status === 'running' ? '◌' : operation.status === 'skipped' ? '·' : '·',
    iconColor: operation.status === 'done' ? '#c3e88d' : operation.status === 'failed' ? '#ff5370' : operation.status === 'running' ? '#82aaff' : '#616161',
    anim: operation.status === 'running' ? 'op-pulse 0.8s ease-in-out infinite' : 'none',
    statusText,
    statusColor: operation.status === 'done' ? '#c3e88d' : operation.status === 'failed' ? '#ff5370' : operation.status === 'running' ? '#82aaff' : '#727272',
    border: operation.status === 'failed' ? 'rgba(255,83,112,0.4)' : '#3a3a3a',
    opacity: operation.status === 'pending' || operation.status === 'skipped' ? 0.5 : 1
  };
}

function buildOperationGroups(operations: ApplyOperationRowView[], errors: Record<string, string>): ApplyOperationGroupView[] {
  const groups = new Map<string, ApplyOperationRowView[]>();
  for (const operation of operations) {
    const groupOperations = groups.get(operation.groupId) ?? [];
    groupOperations.push(operation);
    groups.set(operation.groupId, groupOperations);
  }
  return Array.from(groups, ([id, groupOperations]) => {
    const error = errors[id];
    const status = error ? "failed" : operationGroupStatus(groupOperations);
    return {
      id,
      label: groupOperations[0]?.groupLabel ?? id,
      status,
      statusText: error ? "校验失败" : operationGroupStatusText(status, groupOperations),
      statusColor: operationGroupStatusColor(status),
      completed: groupOperations.filter((operation) => operation.status === "done" || operation.status === "failed" || operation.status === "skipped").length,
      total: groupOperations.length,
      error,
      operations: groupOperations,
    };
  });
}

function operationGroupStatus(operations: ApplyOperationRowView[]): ApplyStatus {
  if (operations.some((operation) => operation.status === "failed")) {
    return "failed";
  }
  if (operations.some((operation) => operation.status === "running")) {
    return "running";
  }
  if (operations.some((operation) => operation.status === "pending")) {
    return "pending";
  }
  if (operations.some((operation) => operation.status === "skipped")) {
    return "skipped";
  }
  return "done";
}

function operationGroupStatusText(status: ApplyStatus, operations: ApplyOperationRowView[]): string {
  if (status === "failed") {
    return "执行失败";
  }
  if (status === "running") {
    return "执行中";
  }
  if (status === "pending") {
    return "等待执行";
  }
  if (status === "skipped") {
    return operations.every((operation) => operation.status === "skipped") ? "已跳过" : "部分跳过";
  }
  return operations.some((operation) => operation.dryRun) ? "试写完成" : "执行成功";
}

function operationGroupStatusColor(status: ApplyStatus): string {
  if (status === "done") {
    return "#C3E88D";
  }
  if (status === "failed") {
    return "#FF5370";
  }
  if (status === "running") {
    return "#82AAFF";
  }
  return "#727272";
}

function searchKeywords(value: string): string[] {
  return Array.from(new Set(
    value
      .normalize('NFKC')
      .split(/\s+/)
      .map((keyword) => keyword.trim())
      .filter(Boolean)
  ));
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStaleAnalysisError(message: string): boolean {
  return message.includes('分析结果已过期');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
