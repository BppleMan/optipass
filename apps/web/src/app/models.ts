import type { DuplicateCandidateClass, ExecutionPlan, ItemDecision, ItemSummary } from '@optimize-password/core';

export type AppStep = 'scan' | 'analysis' | 'applying' | 'summary';
export type AuthState = 'idle' | 'authorizing' | 'authorized' | 'failed';
export type DuplicateKind = 'similar' | 'identical' | 'incomplete';
export type AnalysisDisplayMode = 'edit' | 'preview';
export type AnalysisFilterSectionId = 'years' | 'vaults' | 'domains' | 'credentials';
export type AnalysisFilterKey = 'year' | 'vault' | 'domain' | 'credential';
export type FilterCredentialKind = 'password' | 'totp' | 'passkey';
export type RemoveAction = 'archive' | 'delete';
export type ApplyStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface TypeCountView {
  name: string;
  count: number;
  final: number;
  color: string;
  countColor: string;
}

export interface ScanVaultRow {
  id: string;
  icon: string;
  name: string;
  scanned: number;
  total: number;
  pct: number;
  started: boolean;
  status: string;
  statusColor: string;
  barColor: string;
  typeRows: TypeCountView[];
}

export interface TabView {
  kind: string;
  label: string;
  count?: number;
  color: string;
  bg: string;
}

export interface KindTabView extends TabView {
  kind: DuplicateKind;
  count: number;
}

export interface CredentialChipView {
  kind: 'password' | 'totp' | 'passkey' | 'missing';
  label: string;
  bg: string;
  color: string;
  text: string;
  textColor: string;
}

export interface VaultOptionView {
  id: string;
  label: string;
}

export type ItemDetailFieldKey = 'username' | 'title' | 'url' | 'credentials' | 'strength' | 'vault' | 'category' | 'updated' | 'created' | 'tags';

export interface ItemDetailRowView {
  key: ItemDetailFieldKey;
  label: string;
  value: string;
}

export interface AnalysisFilterOptionView {
  id: string;
  label: string;
  count: number;
  selected: boolean;
}

export interface AnalysisFilterSectionView {
  id: AnalysisFilterSectionId;
  label: string;
  countLabel: string;
  expanded: boolean;
  searchable: boolean;
  query: string;
  emptyText: string;
  options: AnalysisFilterOptionView[];
}

export interface AnalysisFilterChipView {
  key: AnalysisFilterKey;
  id: string;
  label: string;
}

export interface AnalysisFilterSummaryView {
  total: number;
  visible: number;
  activeCount: number;
  chips: AnalysisFilterChipView[];
}

export interface DuplicateItemView {
  id: string;
  title: string;
  username: string;
  url: string;
  categoryLabel: string;
  updated: string;
  strength: string;
  vaultId: string;
  vaultName: string;
  keep: boolean;
  notKeep: boolean;
  targetVault: string;
  removeAction: RemoveAction;
  removeBorder: string;
  removeColor: string;
  rowBg: string;
  strengthBg: string;
  strengthColor: string;
  secretVisible: boolean;
  secretLoading: boolean;
  credentialSignature: string;
  credChips: CredentialChipView[];
  detailRows: ItemDetailRowView[];
  vaultOptions: VaultOptionView[];
}

export type DetailCompareFieldKey =
  | 'title'
  | 'username'
  | 'url'
  | 'credentials'
  | 'vault'
  | 'category'
  | 'time'
  | 'tags';

export interface DetailCompareFieldView {
  key: DetailCompareFieldKey;
  label: string;
  value: string;
  tone: 'default' | 'url' | 'credential' | 'warning';
  different: boolean;
}

export interface DuplicateGroupView {
  id: string;
  kind: DuplicateKind;
  kindLabel: string;
  badgeBg: string;
  badgeColor: string;
  site: string;
  username: string;
  count: number;
  skipped: boolean;
  opacity: number;
  cardBorder: string;
  skipLabel: string;
  skipColor: string;
  filterYears: string[];
  filterVaultIds: string[];
  filterDomains: string[];
  filterCredentialKinds: FilterCredentialKind[];
  items: DuplicateItemView[];
}

export interface DecisionStatsView {
  groups: number;
  keep: number;
  archive: number;
  delete: number;
  move: number;
}

export interface PreviewGroupView {
  id: string;
  kind: DuplicateKind;
  kindLabel: string;
  badgeBg: string;
  badgeColor: string;
  username: string;
  site: string;
  skipped: boolean;
  opacity: number;
  cardBorder: string;
  skipColor: string;
  items: DuplicateItemView[];
  plan?: ExecutionPlan;
  actions: PlanActionPreviewView[];
}

export interface PlanActionPreviewView {
  id: string;
  itemId: string;
  title: string;
  username: string;
  url: string;
  created: string;
  updated: string;
  strength: string;
  vaultName: string;
  opLabel: string;
  targetLabel: string;
  detail: string;
  tone: 'keep' | 'archive' | 'delete' | 'move';
  color: string;
  bg: string;
  border: string;
}

export interface GroupPlanDialogView {
  groupId: string;
  title: string;
  subtitle: string;
  plan: ExecutionPlan;
  actions: PlanActionPreviewView[];
  operationCount: number;
}

export interface ApplyOperationView {
  id: string;
  groupId: string;
  itemId: string;
  type: 'archive' | 'delete' | 'move';
  label: string;
  status: ApplyStatus;
  error?: string;
}

export interface ApplyOperationRowView extends ApplyOperationView {
  icon: string;
  iconColor: string;
  anim: string;
  statusText: string;
  statusColor: string;
  border: string;
  opacity: number;
}

export interface SummaryCardView {
  label: string;
  value: number;
  color: string;
}

export function kindFromCandidateClass(candidateClass: DuplicateCandidateClass): DuplicateKind {
  switch (candidateClass) {
    case 'exact-duplicate':
      return 'identical';
    case 'delete-suggestion':
      return 'incomplete';
    case 'misc-title':
      return 'incomplete';
    case 'similar-login':
      return 'similar';
  }
}

export function removeActionFromDecision(decision: ItemDecision): RemoveAction {
  return decision.deleteMode === 'delete' ? 'delete' : 'archive';
}

export function itemUpdatedDate(item: ItemSummary): string {
  return item.updatedAt ? item.updatedAt.slice(0, 10) : '-';
}
