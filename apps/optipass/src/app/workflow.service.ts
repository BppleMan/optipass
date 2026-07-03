import { computed, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  createExecutionPlan,
  dashboardCategoryDefinitions,
  type DashboardCategory,
  type DuplicateGroup,
  type ExecutionPlan,
  type GroupDecision,
  type ItemDecision,
  type ItemSummary,
  type PlanAction,
  type ScanProgress,
  type ScanResult,
  type ScanSnapshot,
  type VaultScanSummary,
  type VaultSummary
} from '@optimize-password/core';
import { ApiService, type ExecuteResponse } from './api.service';
import {
  type ApplyOperationRowView,
  type ApplyOperationView,
  type ApplyStatus,
  type CredentialChipView,
  type DecisionStatsView,
  type DuplicateGroupView,
  type DuplicateItemView,
  type DuplicateKind,
  type KindTabView,
  type PreviewGroupView,
  type RemoveAction,
  type ScanVaultRow,
  type SummaryCardView,
  itemUpdatedDate,
  kindFromCandidateClass,
  removeActionFromDecision
} from './models';

const accountNameStorageKey = 'optipass.accountName';
const deleteConfirmationPhrase = '永久删除';

const kindOrder: DuplicateKind[] = ['similar', 'identical', 'incomplete'];
const kindMeta: Record<DuplicateKind, { label: string; color: string; bg: string }> = {
  similar: { label: '近似组', color: '#82aaff', bg: 'rgba(130,170,255,0.14)' },
  identical: { label: '全等组', color: '#89ddff', bg: 'rgba(137,221,255,0.14)' },
  incomplete: { label: '建议删除', color: '#ffcb6b', bg: 'rgba(255,203,107,0.14)' }
};

const categoryDisplay: Record<string, { label: string; order: number }> = {
  login: { label: 'Login', order: 1 },
  password: { label: 'Password', order: 2 },
  'secure-note': { label: 'Secure Note', order: 3 },
  'credit-card': { label: 'Credit Card', order: 4 },
  'api-credential': { label: 'API Credential', order: 5 },
  database: { label: 'Database', order: 6 },
  'ssh-key': { label: 'SSH Key', order: 7 },
  document: { label: 'Document', order: 8 },
  identity: { label: 'Identity', order: 9 },
  server: { label: 'Server', order: 10 },
  other: { label: 'Other', order: 99 }
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
  readonly decisions = signal<Record<string, ItemDecision>>({});
  readonly skippedGroups = signal<Record<string, boolean>>({});
  readonly reveal = signal(false);
  readonly visibleSecretItems = signal<Record<string, boolean>>({});
  readonly revealingItems = signal<Record<string, boolean>>({});
  readonly revealedSecrets = signal<Record<string, string>>({});
  readonly activeKind = signal<DuplicateKind>('similar');
  readonly previewKind = signal<DuplicateKind>('similar');
  readonly phase = signal<'preview' | 'applying' | 'summary'>('preview');
  readonly operations = signal<ApplyOperationView[]>([]);
  readonly applying = signal(false);
  readonly applyMessage = signal<string | undefined>(undefined);

  readonly session = computed(() => this.api.session());
  readonly accountChip = computed(() => {
    const account = this.account().trim();
    const authed = this.authState() === 'authorized' || Boolean(this.scanSnapshot()) || Boolean(this.scanResult());
    return authed && account ? `● ${account}` : '';
  });
  readonly scanData = computed(() => this.scanResult() ?? this.scanSnapshot());
  readonly scanDone = computed(() => this.scanProgress()?.phase === 'completed' || Boolean(this.scanSnapshot()));
  readonly scanFailed = computed(() => this.scanProgress()?.phase === 'failed');
  readonly scanRows = computed(() => this.buildScanRows());
  readonly totalItems = computed(() => this.scanProgress()?.totalItems || this.scanData()?.items.length || 0);
  readonly scannedTotal = computed(() => this.scanProgress()?.scannedItems || this.scanData()?.items.length || 0);
  readonly overallPct = computed(() => {
    const total = this.totalItems();
    return total ? Math.round((this.scannedTotal() / total) * 100) : 100;
  });
  readonly authHint = computed(() => {
    if (this.error() && this.authState() === 'failed') {
      return '';
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
  readonly authHintClass = computed(() => this.authState() === 'failed' ? 'danger-text' : this.authState() === 'authorizing' ? 'warn-text' : 'ok-text');
  readonly groups = computed(() => (this.scanResult()?.groups ?? []).filter((group) => group.candidateClass !== 'misc-title'));
  readonly kindTabs = computed<KindTabView[]>(() => this.buildKindTabs());
  readonly visibleGroups = computed<DuplicateGroupView[]>(() => this.buildVisibleGroups());
  readonly decisionStats = computed<DecisionStatsView>(() => this.buildDecisionStats());
  readonly allPreviewGroups = computed<PreviewGroupView[]>(() => this.buildPreviewGroups());
  readonly planOperationCount = computed(() => this.countPlanOperations());
  readonly visiblePreviewGroups = computed(() => this.allPreviewGroups().filter((group) => group.kind === this.previewKind()));
  readonly previewTabs = computed<KindTabView[]>(() => this.buildPreviewTabs());
  readonly previewEmpty = computed(() => this.visiblePreviewGroups().length === 0);
  readonly liveExecutionDisabled = computed(() => {
    const session = this.session();
    return this.activeScanMode() === 'live' && session ? !session.enableMutations : false;
  });
  readonly canApply = computed(() => this.planOperationCount() > 0 && !this.loading() && !this.applying() && !this.liveExecutionDisabled());
  readonly operationRows = computed<ApplyOperationRowView[]>(() => this.operations().map((operation) => toOperationRow(operation)));
  readonly applyPct = computed(() => {
    const operations = this.operations();
    if (operations.length === 0) {
      return 0;
    }
    const finished = operations.filter((operation) => ['done', 'failed', 'skipped'].includes(operation.status)).length;
    return Math.round((finished / operations.length) * 100);
  });
  readonly summaryCards = computed<SummaryCardView[]>(() => {
    const operations = this.operations();
    return [
      { label: '保留', value: this.decisionStats().keep, color: '#c3e88d' },
      { label: '已归档', value: operations.filter((operation) => operation.type === 'archive' && operation.status === 'done').length, color: '#ffcb6b' },
      { label: '已删除', value: operations.filter((operation) => operation.type === 'delete' && operation.status === 'done').length, color: '#ff5370' },
      { label: '已迁移', value: operations.filter((operation) => operation.type === 'move' && operation.status === 'done').length, color: '#82aaff' }
    ];
  });
  readonly summaryLine = computed(() => {
    const operations = this.operations();
    const failed = operations.filter((operation) => operation.status === 'failed').length;
    const skipped = operations.filter((operation) => operation.status === 'skipped').length;
    const success = operations.filter((operation) => operation.status === 'done').length;
    return `共执行 ${operations.length} 项操作，成功 ${success} 项${failed ? `，失败 ${failed} 项` : ''}${skipped ? `，跳过 ${skipped} 项` : ''}`;
  });
  readonly hasFailed = computed(() => this.operations().some((operation) => operation.status === 'failed'));

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

  updateAccount(value: string): void {
    this.account.set(value);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(accountNameStorageKey, value);
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
    try {
      const start = await this.api.startScan({ accountName: resolvedAccountName, mode });
      this.activeScanMode.set(start.mode);
      this.scanProgress.set(start.progress);
      await this.api.streamScanEvents(start.scanId, (event) => {
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
      });

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
      this.loading.set(false);
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
      this.scanResult.set(result);
      this.scanSnapshot.set({
        scanId: result.scanId,
        scannedAt: result.scannedAt,
        vaults: result.vaults,
        items: result.items
      });
      this.decisions.set(this.defaultDecisions(result));
      this.skippedGroups.set({});
      this.visibleSecretItems.set({});
      this.revealingItems.set({});
      this.revealedSecrets.set({});
      this.reveal.set(false);
      this.activeKind.set(firstAvailableKind(result.groups));
      this.previewKind.set(firstAvailableKind(result.groups));
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
    this.resetForScan();
    await this.router.navigateByUrl('/scan');
  }

  setActiveKind(kind: DuplicateKind): void {
    this.activeKind.set(kind);
  }

  setPreviewKind(kind: DuplicateKind): void {
    this.previewKind.set(kind);
  }

  toggleGroupSkip(groupId: string): void {
    const skipped = this.skippedGroups();
    this.skippedGroups.set({ ...skipped, [groupId]: !skipped[groupId] });
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
    const secrets = { ...this.revealedSecrets() };
    const visibleItemIds = this.visibleGroups().flatMap((group) => group.items.map((item) => item.id));
    for (const itemId of visibleItemIds) {
      if (secrets[itemId]) {
        continue;
      }
      try {
        const response = await this.api.revealCredentials(result.scanId, itemId);
        const field = response.fields.find((candidate) => candidate.value.trim()) ?? response.fields[0];
        if (field?.value) {
          secrets[itemId] = field.value;
          this.revealedSecrets.set({ ...secrets });
        }
      } catch {
        secrets[itemId] = '显示失败';
        this.revealedSecrets.set({ ...secrets });
      }
    }
  }

  async toggleItemReveal(itemId: string): Promise<void> {
    const visible = this.visibleSecretItems();
    if (visible[itemId]) {
      this.visibleSecretItems.set({ ...visible, [itemId]: false });
      return;
    }

    this.visibleSecretItems.set({ ...visible, [itemId]: true });
    if (this.revealedSecrets()[itemId]) {
      return;
    }

    const result = this.scanResult();
    if (!result || this.revealingItems()[itemId]) {
      return;
    }

    this.revealingItems.set({ ...this.revealingItems(), [itemId]: true });
    try {
      const response = await this.api.revealCredentials(result.scanId, itemId);
      const field = response.fields.find((candidate) => candidate.value.trim()) ?? response.fields[0];
      this.revealedSecrets.set({
        ...this.revealedSecrets(),
        [itemId]: field?.value || '无可显示密码'
      });
    } catch {
      this.revealedSecrets.set({ ...this.revealedSecrets(), [itemId]: '显示失败' });
    } finally {
      this.revealingItems.set({ ...this.revealingItems(), [itemId]: false });
    }
  }

  async goPreview(): Promise<void> {
    this.phase.set('preview');
    this.previewKind.set(this.activeKind());
    this.operations.set(this.buildOperations());
    await this.router.navigateByUrl('/preview');
  }

  async backToAnalysis(): Promise<void> {
    this.phase.set('preview');
    await this.router.navigateByUrl('/analysis');
  }

  async applyPlan(): Promise<void> {
    if (!this.canApply()) {
      return;
    }
    const groups = this.allPreviewGroups();
    const operations = this.buildOperations();
    this.operations.set(operations);
    this.phase.set('applying');
    this.applying.set(true);
    this.applyMessage.set(undefined);

    for (const group of groups) {
      const groupOps = this.operations().filter((operation) => operation.groupId === group.id);
      if (groupOps.length === 0) {
        continue;
      }
      this.patchGroupOperations(group.id, 'running');
      try {
        const decision = this.groupDecisionById(group.id);
        if (!decision) {
          throw new Error('找不到待执行的重复组。');
        }
        const response = await this.executeGroupDecision(decision);
        if (response.blocked || response.error) {
          this.failGroup(group.id, response.error || '执行被本地 API 阻止。');
          this.skipPendingOperations();
          break;
        }
        this.applyGroupResult(group.id, response);
        if (response.scanInvalidated) {
          this.skipPendingOperations();
          break;
        }
      } catch (error) {
        this.failGroup(group.id, messageFor(error));
        this.skipPendingOperations();
        break;
      }
    }

    this.phase.set('summary');
    this.applying.set(false);
  }

  resetAll(): void {
    this.resetForScan();
    void this.router.navigateByUrl('/scan');
  }

  planForPreviewGroup(groupId: string): ExecutionPlan | undefined {
    const group = this.groups().find((candidate) => candidate.id === groupId);
    const result = this.scanResult();
    if (!group || !result) {
      return undefined;
    }
    return this.createLocalPlan(group, result.items);
  }

  itemById(itemId: string): ItemSummary | undefined {
    return this.scanResult()?.items.find((item) => item.id === itemId);
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
    this.revealedSecrets.set({});
    this.activeKind.set('similar');
    this.previewKind.set('similar');
    this.phase.set('preview');
    this.operations.set([]);
    this.applying.set(false);
    this.applyMessage.set(undefined);
  }

  private defaultDecisions(result: ScanResult): Record<string, ItemDecision> {
    const decisions: Record<string, ItemDecision> = {};
    for (const group of result.groups) {
      const recommended = new Set(group.recommendedKeepIds);
      const items = group.itemIds
        .map((id) => result.items.find((item) => item.id === id))
        .filter((item): item is ItemSummary => Boolean(item));
      const fallbackKeepId = items.slice().sort((a, b) => itemUpdatedDate(b).localeCompare(itemUpdatedDate(a)))[0]?.id;
      for (const item of items) {
        const keep = group.candidateClass === 'delete-suggestion'
          ? false
          : recommended.size > 0
            ? recommended.has(item.id)
            : item.id === fallbackKeepId;
        decisions[item.id] = {
          itemId: item.id,
          keep,
          targetVaultId: item.vaultId,
          deleteMode: 'archive'
        };
      }
    }
    return decisions;
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
      icon: ['🔒', '💼', '🏠', '🗄'][index % 4],
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

  private buildKindTabs(): KindTabView[] {
    const groups = this.groups();
    return kindOrder.map((kind) => ({
      kind,
      label: kindMeta[kind].label,
      color: kindMeta[kind].color,
      bg: kindMeta[kind].bg,
      count: groups.filter((group) => kindFromCandidateClass(group.candidateClass) === kind).length
    }));
  }

  private buildPreviewTabs(): KindTabView[] {
    const groups = this.allPreviewGroups();
    return kindOrder.map((kind) => ({
      kind,
      label: kindMeta[kind].label,
      color: kindMeta[kind].color,
      bg: kindMeta[kind].bg,
      count: groups.filter((group) => group.kind === kind).length
    }));
  }

  private buildVisibleGroups(): DuplicateGroupView[] {
    const result = this.scanResult();
    if (!result) {
      return [];
    }
    const itemById = new Map(result.items.map((item) => [item.id, item]));
    return this.groups()
      .filter((group) => kindFromCandidateClass(group.candidateClass) === this.activeKind())
      .map((group) => this.toGroupView(group, itemById, result.vaults));
  }

  private toGroupView(group: DuplicateGroup, itemById: Map<string, ItemSummary>, vaults: VaultSummary[]): DuplicateGroupView {
    const kind = kindFromCandidateClass(group.candidateClass);
    const meta = kindMeta[kind];
    const items = group.itemIds.map((id) => itemById.get(id)).filter((item): item is ItemSummary => Boolean(item));
    const skipped = Boolean(this.skippedGroups()[group.id]);
    return {
      id: group.id,
      kind,
      kindLabel: meta.label,
      badgeBg: meta.bg,
      badgeColor: meta.color,
      site: groupSite(group, items),
      username: groupUsername(group, items),
      count: items.length,
      skipped,
      opacity: skipped ? 0.45 : 1,
      cardBorder: skipped ? '#3a3a3a' : '#3F3F3F',
      skipLabel: skipped ? '恢复此组' : '跳过此组',
      skipColor: skipped ? '#82aaff' : '#B0BEC5',
      items: items.map((item) => this.toItemView(group, item, vaults, skipped))
    };
  }

  private toItemView(group: DuplicateGroup, item: ItemSummary, vaults: VaultSummary[], skipped: boolean): DuplicateItemView {
    const decision = this.decisions()[item.id] ?? {
      itemId: item.id,
      keep: false,
      targetVaultId: item.vaultId,
      deleteMode: 'archive'
    };
    const removeAction = removeActionFromDecision(decision);
    const strength = strengthLabel(item, group);
    return {
      id: item.id,
      title: item.title,
      username: item.usernames.find(Boolean) ?? '（无 username）',
      url: item.urls[0] || '—',
      recommendationLabel: recommendationLabel(group, item.id),
      updated: itemUpdatedDate(item),
      strength,
      vaultName: item.vaultName,
      keep: decision.keep,
      notKeep: !decision.keep,
      recommended: decision.keep && group.recommendedKeepIds.includes(item.id),
      targetVault: decision.targetVaultId || item.vaultId,
      removeAction,
      removeBorder: removeAction === 'delete' ? 'rgba(255,83,112,0.5)' : '#3F3F3F',
      removeColor: removeAction === 'delete' ? '#ff5370' : '#ffcb6b',
      rowBg: decision.keep && !skipped ? 'rgba(130,170,255,0.04)' : 'transparent',
      strengthBg: strengthBackground(strength),
      strengthColor: strengthColor(strength),
      secretVisible: Boolean(this.visibleSecretItems()[item.id]),
      secretLoading: Boolean(this.revealingItems()[item.id]),
      credChips: credentialChips(item, Boolean(this.visibleSecretItems()[item.id]), this.revealedSecrets()[item.id]),
      vaultOptions: vaults.map((vault) => ({
        id: vault.id,
        label: vault.id === item.vaultId ? `${vault.name}（原）` : `迁移至 ${vault.name}`
      }))
    };
  }

  private buildDecisionStats(): DecisionStatsView {
    const result = this.scanResult();
    if (!result) {
      return { groups: 0, keep: 0, archive: 0, delete: 0, move: 0 };
    }
    const itemById = new Map(result.items.map((item) => [item.id, item]));
    const stats = { groups: 0, keep: 0, archive: 0, delete: 0, move: 0 };
    for (const group of this.groups()) {
      if (this.skippedGroups()[group.id]) {
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
    return this.groups()
      .filter((group) => !this.skippedGroups()[group.id])
      .map((group) => {
        const kind = kindFromCandidateClass(group.candidateClass);
        const meta = kindMeta[kind];
        const items = group.itemIds.map((id) => itemById.get(id)).filter((item): item is ItemSummary => Boolean(item));
        const after = items.map((item) => previewAfterLine(item, this.decisions()[item.id], result.vaults));
        const changed = after.some((line) => line.deco === 'line-through' || line.tagColor === '#82aaff');
        return {
          id: group.id,
          kind,
          kindLabel: meta.label,
          badgeBg: meta.bg,
          badgeColor: meta.color,
          username: groupUsername(group, items),
          site: groupSite(group, items),
          before: items.map((item) => ({ title: item.title, vaultName: item.vaultName })),
          after,
          plan: this.createLocalPlan(group, result.items)
        };
      })
      .filter((group) => group.before.length > 0 && group.after.length > 0 && group.plan && group.plan.actions.some((action) => action.type !== 'keep'));
  }

  private countPlanOperations(): number {
    return this.allPreviewGroups().reduce((total, group) => {
      const actions = group.plan?.actions ?? [];
      return total + actions.filter((action) => action.type !== 'keep').length;
    }, 0);
  }

  private createLocalPlan(group: DuplicateGroup, items: ItemSummary[]): ExecutionPlan {
    return createExecutionPlan(group.id, this.groupDecision(group, items), items, {
      requireKeep: group.candidateClass !== 'delete-suggestion'
    });
  }

  private groupDecision(group: DuplicateGroup, items: ItemSummary[]): GroupDecision {
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
          deleteMode: decision?.deleteMode ?? 'archive'
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

  private buildOperations(): ApplyOperationView[] {
    return this.allPreviewGroups().flatMap((group) => {
      const plan = group.plan;
      if (!plan) {
        return [];
      }
      return plan.actions
        .filter((action) => action.type !== 'keep')
        .map((action) => this.toApplyOperation(group.id, action));
    });
  }

  private toApplyOperation(groupId: string, action: Exclude<PlanAction, { type: 'keep' }>): ApplyOperationView {
    const item = this.itemById(action.itemId);
    const title = item?.title || action.itemId;
    if (action.type === 'copy-to-vault-and-archive-source') {
      const targetName = vaultName(this.scanResult()?.vaults ?? [], action.targetVaultId);
      return {
        id: `op-${action.itemId}`,
        groupId,
        itemId: action.itemId,
        type: 'move',
        label: `迁移「${title}」：${item?.vaultName ?? action.vaultId} → ${targetName}`,
        status: 'pending'
      };
    }
    return {
      id: `op-${action.itemId}`,
      groupId,
      itemId: action.itemId,
      type: action.type,
      label: `${action.type === 'delete' ? '删除' : '归档'}「${title}」（${item?.vaultName ?? action.vaultId}）`,
      status: 'pending'
    };
  }

  private async executeGroupDecision(decision: GroupDecision): Promise<ExecuteResponse> {
    const hasDelete = decision.items.some((item) => !item.keep && item.deleteMode === 'delete');
    if (this.activeScanMode() === 'live') {
      const dryRun = await this.api.execute({ ...decision, dryRun: true });
      if (dryRun.blocked || !dryRun.dryRunKey) {
        return dryRun;
      }
      return this.api.execute({
        ...decision,
        confirmedDryRunKey: dryRun.dryRunKey,
        confirmPermanentDelete: hasDelete || undefined,
        permanentDeleteConfirmationPhrase: hasDelete ? deleteConfirmationPhrase : undefined
      });
    }
    return this.api.execute({
      ...decision,
      confirmPermanentDelete: hasDelete || undefined,
      permanentDeleteConfirmationPhrase: hasDelete ? deleteConfirmationPhrase : undefined
    });
  }

  private applyGroupResult(groupId: string, response: ExecuteResponse): void {
    const results = response.results ?? [];
    if (results.length === 0) {
      this.patchGroupOperations(groupId, 'done');
      return;
    }
    const next = this.operations().map((operation) => {
      if (operation.groupId !== groupId) {
        return operation;
      }
      const result = results.find((candidate) => candidate.itemId === operation.itemId);
      if (!result) {
        return { ...operation, status: 'done' as ApplyStatus };
      }
      if (result.skipped) {
        return { ...operation, status: 'skipped' as ApplyStatus, error: result.error };
      }
      return { ...operation, status: result.ok ? ('done' as ApplyStatus) : ('failed' as ApplyStatus), error: result.error };
    });
    this.operations.set(next);
  }

  private patchGroupOperations(groupId: string, status: ApplyStatus): void {
    this.operations.set(this.operations().map((operation) => operation.groupId === groupId ? { ...operation, status } : operation));
  }

  private failGroup(groupId: string, error: string): void {
    this.operations.set(this.operations().map((operation) => operation.groupId === groupId ? { ...operation, status: 'failed', error } : operation));
    this.applyMessage.set(error);
  }

  private skipPendingOperations(): void {
    this.operations.set(this.operations().map((operation) => operation.status === 'pending' ? { ...operation, status: 'skipped', error: '前序操作失败，已跳过。' } : operation));
  }
}

function readStoredAccountName(): string | undefined {
  if (typeof localStorage === 'undefined') {
    return undefined;
  }
  return localStorage.getItem(accountNameStorageKey) ?? undefined;
}

function firstAvailableKind(groups: DuplicateGroup[]): DuplicateKind {
  for (const kind of kindOrder) {
    if (groups.some((group) => kindFromCandidateClass(group.candidateClass) === kind)) {
      return kind;
    }
  }
  return 'similar';
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
      name: categoryDisplay[category]?.label ?? category,
      count,
      final: count,
      order: categoryDisplay[category]?.order ?? 50,
      color: '#B0BEC5',
      countColor: '#eeffff'
    }))
    .sort((a, b) => a.order - b.order)
    .slice(0, 6);
}

function groupUsername(group: DuplicateGroup, items: ItemSummary[]): string {
  if (group.candidateClass === 'delete-suggestion') {
    return '（缺失关键字段）';
  }
  return items.flatMap((item) => item.usernames).find(Boolean) ?? '（无 username）';
}

function groupSite(group: DuplicateGroup, items: ItemSummary[]): string {
  if (group.candidateClass === 'delete-suggestion') {
    return '—';
  }
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

function recommendationLabel(group: DuplicateGroup, itemId: string): string {
  const reason = group.recommendedKeepReasons.find((candidate) => candidate.itemId === itemId);
  if (!reason) {
    return '';
  }
  const label = reason.labels.includes('最近更新') ? '最新' : reason.labels[0];
  return label ? `推荐保留 · ${label}` : '推荐保留';
}

function credentialChips(item: ItemSummary, reveal: boolean, revealedValue: string | undefined): CredentialChipView[] {
  const chips: CredentialChipView[] = [];
  if (item.hasPasskey) {
    chips.push({ kind: 'passkey', label: 'Passkey', bg: 'rgba(137,221,255,0.14)', color: '#89ddff', text: '已创建', textColor: '#B0BEC5' });
  }
  if (item.hasPassword) {
    chips.push({
      kind: 'password',
      label: '密码',
      bg: 'rgba(130,170,255,0.12)',
      color: '#82aaff',
      text: reveal ? (revealedValue ?? '读取中…') : '••••••••••',
      textColor: revealedValue === '显示失败' ? '#ff5370' : '#B0BEC5'
    });
  }
  if (item.hasTotp) {
    chips.push({ kind: 'totp', label: '一次性密码', bg: 'rgba(255,203,107,0.14)', color: '#ffcb6b', text: 'TOTP', textColor: '#B0BEC5' });
  }
  if (chips.length === 0) {
    chips.push({ kind: 'missing', label: '缺失', bg: 'rgba(255,83,112,0.14)', color: '#ff5370', text: '（无 password）', textColor: '#ff5370' });
  }
  return chips;
}

function strengthLabel(item: ItemSummary, group: DuplicateGroup): string {
  if (!item.hasPassword && !item.hasPasskey && !item.hasTotp) {
    return group.candidateClass === 'delete-suggestion' ? '弱' : '—';
  }
  if (item.hasPasskey || item.hasTotp) {
    return '强';
  }
  return group.recommendedKeepIds.includes(item.id) ? '中' : '弱';
}

function strengthBackground(strength: string): string {
  if (strength === '强') {
    return 'rgba(195,232,141,0.14)';
  }
  if (strength === '中') {
    return 'rgba(255,203,107,0.14)';
  }
  if (strength === '弱') {
    return 'rgba(255,83,112,0.14)';
  }
  return '#323232';
}

function strengthColor(strength: string): string {
  if (strength === '强') {
    return '#c3e88d';
  }
  if (strength === '中') {
    return '#ffcb6b';
  }
  if (strength === '弱') {
    return '#ff5370';
  }
  return '#727272';
}

function previewAfterLine(item: ItemSummary, decision: ItemDecision | undefined, vaults: VaultSummary[]) {
  if (!decision?.keep) {
    const removeAction = decision?.deleteMode === 'delete' ? 'delete' : 'archive';
    return {
      title: item.title,
      tag: removeAction === 'delete' ? '删除' : '归档',
      tagColor: removeAction === 'delete' ? '#ff5370' : '#ffcb6b',
      bg: 'transparent',
      border: '#323232',
      deco: 'line-through',
      color: '#727272'
    };
  }
  const moved = (decision.targetVaultId || item.vaultId) !== item.vaultId;
  return {
    title: item.title,
    tag: moved ? `迁移 → ${vaultName(vaults, decision.targetVaultId || item.vaultId)}` : `保留 · ${item.vaultName}`,
    tagColor: moved ? '#82aaff' : '#c3e88d',
    bg: 'rgba(195,232,141,0.06)',
    border: 'rgba(195,232,141,0.3)',
    deco: 'none',
    color: '#eeffff'
  };
}

function vaultName(vaults: VaultSummary[], vaultId: string): string {
  return vaults.find((vault) => vault.id === vaultId)?.name ?? vaultId;
}

function toOperationRow(operation: ApplyOperationView): ApplyOperationRowView {
  const statusText = operation.status === 'done'
    ? '成功'
    : operation.status === 'failed'
      ? operation.error || '失败'
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

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
