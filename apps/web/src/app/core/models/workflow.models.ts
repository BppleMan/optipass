import { ItemDisposition, type ActionDraftItem, type ActionPlanGroupDto, type ItemSummary } from "@optimize-password/core";

export enum AppStep {
  Scan = 'scan', Analysis = 'analysis', Applying = 'applying', Summary = 'summary',
}
export enum AuthState {
  Idle = 'idle', Authorizing = 'authorizing', Authorized = 'authorized', Failed = 'failed',
}
export enum AnalysisFilterSectionId {
  Years = 'years', Vaults = 'vaults', Domains = 'domains', Credentials = 'credentials',
}
export enum AnalysisFilterKey {
  Year = 'year', Vault = 'vault', Domain = 'domain', Credential = 'credential', Search = 'search',
}
export enum FilterCredentialKind {
  Password = 'password', Totp = 'totp', Passkey = 'passkey',
}
export enum RemoveAction {
  Archive = 'archive', Delete = 'delete',
}
export enum ApplyStatus {
  Pending = 'pending', Running = 'running', Done = 'done', Failed = 'failed', Skipped = 'skipped',
}

export enum CredentialFieldKind {
  Password = 'password', Secret = 'secret', Totp = 'totp', Passkey = 'passkey', Missing = 'missing',
}

export enum ItemDetailFieldKey {
  Username = 'username', Title = 'title', Url = 'url', Credentials = 'credentials', Vault = 'vault', Category = 'category',
  Updated = 'updated', Created = 'created', Tags = 'tags',
}

export enum PlanPreviewTone {
  Keep = 'keep', Archive = 'archive', Delete = 'delete', Move = 'move', Tags = 'tags', Skip = 'skip',
}

export enum ApplyOperationType {
  Archive = 'archive', Delete = 'delete', Move = 'move', Tags = 'tags', Title = 'title',
}

export enum TagRemovalScope {
  Item = 'item', Group = 'group',
}

export interface TypeCountView {
  category: string;
  name: string;
  count: number;
  final: number;
  color: string;
  countColor: string;
}

export interface ScanVaultRow {
  id: string;
  iconIndex: number;
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

export interface CredentialChipView {
  kind: CredentialFieldKind;
  label: string;
  bg: string;
  color: string;
  text: string;
  textColor: string;
}

export interface VaultOptionView {
  id: string;
  label: string;
  name: string;
  current: boolean;
}


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
  originalTitle: string;
  titleChanged: boolean;
  username: string;
  url: string;
  category: string;
  categoryLabel: string;
  updated: string;
  vaultId: string;
  vaultName: string;
  keep: boolean;
  notKeep: boolean;
  targetVault: string;
  removeAction: RemoveAction;
  rowBg: string;
  secretVisible: boolean;
  credentialSignature: string;
  credChips: CredentialChipView[];
  tags: string[];
  removedTags: string[];
  remainingTagCount: number;
  detailRows: ItemDetailRowView[];
  vaultOptions: VaultOptionView[];
}

export interface DuplicateGroupView {
  id: string;
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
  skipped: number;
}

export interface PreviewGroupView {
  id: string;
  username: string;
  site: string;
  skipped: boolean;
  opacity: number;
  cardBorder: string;
  skipColor: string;
  items: DuplicateItemView[];
  plan?: ActionPlanGroupDto;
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
  vaultName: string;
  opLabel: string;
  targetLabel: string;
  detail: string;
  tone: PlanPreviewTone;
  removedTags: string[];
  retainedTags: string[];
  color: string;
  bg: string;
  border: string;
}

export interface ApplyOperationView {
  id: string;
  groupId: string;
  groupLabel: string;
  itemId: string;
  type: ApplyOperationType;
  actionId: string;
  sourceAction: import("@optimize-password/core").ActionKind;
  label: string;
  status: ApplyStatus;
  dryRun?: boolean;
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

export interface ApplyOperationGroupView {
  id: string;
  label: string;
  status: ApplyStatus;
  statusText: string;
  statusColor: string;
  completed: number;
  total: number;
  error?: string;
  operations: ApplyOperationRowView[];
}

export function removeActionFromDecision(decision: ActionDraftItem): RemoveAction {
  return decision.disposition === ItemDisposition.Delete ? RemoveAction.Delete : RemoveAction.Archive;
}

export function itemUpdatedDate(item: ItemSummary): string {
  return item.updatedAt ? item.updatedAt.slice(0, 10) : '-';
}
