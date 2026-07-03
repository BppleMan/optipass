import type { DuplicateCandidateClass, ExecutionPlan, ItemDecision, ItemSummary } from '@optimize-password/core';

export type AppStep = 'scan' | 'analysis' | 'preview' | 'applying' | 'summary';
export type AuthState = 'idle' | 'authorizing' | 'authorized' | 'failed';
export type DuplicateKind = 'similar' | 'identical' | 'incomplete' | 'misc';
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

export interface KindTabView {
  kind: DuplicateKind;
  label: string;
  count: number;
  color: string;
  bg: string;
}

export interface CredentialChipView {
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

export interface DuplicateItemView {
  id: string;
  title: string;
  url: string;
  updated: string;
  strength: string;
  vaultName: string;
  keep: boolean;
  notKeep: boolean;
  recommended: boolean;
  targetVault: string;
  removeAction: RemoveAction;
  removeBorder: string;
  removeColor: string;
  rowBg: string;
  strengthBg: string;
  strengthColor: string;
  credChips: CredentialChipView[];
  vaultOptions: VaultOptionView[];
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
  items: DuplicateItemView[];
}

export interface DecisionStatsView {
  groups: number;
  keep: number;
  archive: number;
  delete: number;
  move: number;
}

export interface PreviewLineView {
  title: string;
  vaultName?: string;
  tag?: string;
  tagColor?: string;
  bg?: string;
  border?: string;
  deco?: string;
  color?: string;
}

export interface PreviewGroupView {
  id: string;
  kind: DuplicateKind;
  kindLabel: string;
  badgeBg: string;
  badgeColor: string;
  username: string;
  site: string;
  before: PreviewLineView[];
  after: PreviewLineView[];
  plan?: ExecutionPlan;
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
      return 'misc';
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
