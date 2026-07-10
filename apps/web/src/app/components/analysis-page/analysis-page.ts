import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OpButtonComponent } from '../op-button/op-button';
import { OpProgressComponent } from '../op-progress/op-progress';
import { OpTabsComponent } from '../op-tabs/op-tabs';
import { PlanActionGroupComponent } from './plan-action-group/plan-action-group';
import { VaultIconComponent } from '../vault-icon/vault-icon';
import { VaultSelectComponent } from '../vault-select/vault-select';
import { WorkflowService } from '../../workflow.service';
import type { AnalysisDisplayMode, DetailCompareFieldKey, DetailCompareFieldView, DuplicateGroupView, DuplicateItemView, DuplicateKind, ItemDetailFieldKey, RemoveAction, TabView } from '../../models';

type GroupRemovalMode = RemoveAction | 'manual';

type TagPopoverState = {
  groupId: string;
  itemId: string;
  left: number;
  top: number;
  above: boolean;
};

@Component({
  selector: 'op-analysis-page',
  standalone: true,
  imports: [FormsModule, OpButtonComponent, OpProgressComponent, OpTabsComponent, PlanActionGroupComponent, VaultIconComponent, VaultSelectComponent],
  templateUrl: './analysis-page.html'
})
export class AnalysisPageComponent implements OnInit {
  readonly displayModeTabs: TabView[] = [
    { kind: 'edit', label: '编辑', color: '#c792ea', bg: 'rgba(199, 146, 234, 0.16)' },
    { kind: 'preview', label: '预览', color: '#c792ea', bg: 'rgba(199, 146, 234, 0.16)' }
  ];

  activeDetailGroupId: string | undefined;
  tagScopePrompt: { groupId: string; itemId: string; tag: string; eligibleCount: number } | undefined;
  tagPopover: TagPopoverState | undefined;
  private readonly expandedTagItems = new Set<string>();
  private tagPopoverCloseTimer: number | undefined;

  @ViewChild('groupList') private readonly groupList?: ElementRef<HTMLElement>;

  constructor(readonly wf: WorkflowService) {}

  ngOnInit(): void {
    void this.wf.restoreCachedState();
  }

  setKind(kind: string): void {
    this.closeGroupDetail();
    this.wf.setActiveKind(kind as DuplicateKind);
  }

  detailGroup(): DuplicateGroupView | undefined {
    const activeGroupId = this.activeDetailGroupId;
    if (!activeGroupId) {
      return undefined;
    }
    return this.wf.visibleGroups().find((group) => group.id === activeGroupId)
      ?? this.wf.activeKindGroups().find((group) => group.id === activeGroupId);
  }

  toggleGroupDetail(groupId: string): void {
    this.activeDetailGroupId = this.activeDetailGroupId === groupId ? undefined : groupId;
  }

  closeGroupDetail(): void {
    this.activeDetailGroupId = undefined;
    this.tagScopePrompt = undefined;
  }

  showTagPopover(event: Event, group: DuplicateGroupView, item: DuplicateItemView): void {
    this.cancelTagPopoverClose();
    const trigger = event.currentTarget as HTMLElement | null;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const width = 276;
    const height = 220;
    const above = rect.bottom + height > window.innerHeight - 12 && rect.top > height;
    this.tagPopover = {
      groupId: group.id,
      itemId: item.id,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      top: above ? rect.top - 8 : rect.bottom + 8,
      above
    };
  }

  scheduleTagPopoverClose(): void {
    this.cancelTagPopoverClose();
    this.tagPopoverCloseTimer = window.setTimeout(() => this.closeTagPopover(), 140);
  }

  cancelTagPopoverClose(): void {
    if (this.tagPopoverCloseTimer !== undefined) {
      window.clearTimeout(this.tagPopoverCloseTimer);
      this.tagPopoverCloseTimer = undefined;
    }
  }

  closeTagPopover(): void {
    this.cancelTagPopoverClose();
    this.tagPopover = undefined;
    this.tagScopePrompt = undefined;
  }

  tagPopoverGroup(): DuplicateGroupView | undefined {
    const groupId = this.tagPopover?.groupId;
    if (!groupId) {
      return undefined;
    }
    return this.wf.visibleGroups().find((group) => group.id === groupId);
  }

  tagPopoverItem(): DuplicateItemView | undefined {
    const itemId = this.tagPopover?.itemId;
    return itemId ? this.tagPopoverGroup()?.items.find((item) => item.id === itemId) : undefined;
  }

  visibleTags(item: DuplicateItemView): string[] {
    return this.expandedTagItems.has(item.id) ? item.tags : item.tags.slice(0, 2);
  }

  hiddenTagCount(item: DuplicateItemView): number {
    return Math.max(0, item.tags.length - this.visibleTags(item).length);
  }

  toggleTagExpansion(itemId: string): void {
    if (this.expandedTagItems.has(itemId)) {
      this.expandedTagItems.delete(itemId);
    } else {
      this.expandedTagItems.add(itemId);
    }
  }

  requestTagRemoval(group: DuplicateGroupView, item: DuplicateItemView, tag: string): void {
    if (item.removedTags.includes(tag)) {
      this.wf.toggleTagRemoval(item.id, tag);
      this.tagScopePrompt = undefined;
      return;
    }
    const eligibleCount = group.items.filter((candidate) => candidate.keep && candidate.tags.includes(tag)).length;
    if (eligibleCount > 1) {
      this.tagScopePrompt = { groupId: group.id, itemId: item.id, tag, eligibleCount };
      return;
    }
    this.wf.toggleTagRemoval(item.id, tag);
  }

  applyTagScope(scope: 'item' | 'group'): void {
    const prompt = this.tagScopePrompt;
    if (!prompt) {
      return;
    }
    if (scope === 'group') {
      this.wf.removeTagFromGroup(prompt.groupId, prompt.tag);
    } else {
      this.wf.toggleTagRemoval(prompt.itemId, prompt.tag);
    }
    this.tagScopePrompt = undefined;
  }

  tagPromptFor(itemId: string, tag: string): boolean {
    return this.tagScopePrompt?.itemId === itemId && this.tagScopePrompt.tag === tag;
  }

  tagSharedAcrossGroup(group: DuplicateGroupView, tag: string): boolean {
    return group.items.length > 1 && group.items.every((item) => item.tags.includes(tag));
  }

  setItemDecision(item: DuplicateItemView, mode: 'keep' | RemoveAction): void {
    this.wf.updateKeep(item.id, mode === 'keep');
    if (mode !== 'keep') {
      this.wf.updateRemoveAction(item.id, mode);
    }
  }

  itemDecisionIndex(item: DuplicateItemView): number {
    if (item.keep) {
      return 0;
    }
    return item.removeAction === 'archive' ? 1 : 2;
  }

  groupRemovalMode(group: DuplicateGroupView): GroupRemovalMode {
    const removable = group.items.filter((item) => !item.keep);
    if (removable.length === 0) {
      return 'manual';
    }
    const first = removable[0].removeAction;
    return removable.every((item) => item.removeAction === first) ? first : 'manual';
  }

  groupRemovalIndex(group: DuplicateGroupView): number {
    const mode = this.groupRemovalMode(group);
    return mode === 'archive' ? 0 : mode === 'delete' ? 1 : 2;
  }

  setGroupRemovalMode(group: DuplicateGroupView, mode: RemoveAction): void {
    this.wf.updateGroupRemoveAction(group.id, mode);
  }

  switchDisplayMode(mode: string): void {
    const displayMode = mode as AnalysisDisplayMode;
    if (this.wf.analysisDisplayMode() === displayMode) {
      return;
    }
    const anchorGroupId = this.visibleAnchorGroupId();
    this.closeGroupDetail();
    this.wf.setAnalysisDisplayMode(displayMode);
    this.restoreAnchorGroup(anchorGroupId);
  }

  handleBatchApply(): void {
    if (this.wf.analysisDisplayMode() !== 'preview') {
      const anchorGroupId = this.visibleAnchorGroupId();
      this.closeGroupDetail();
      this.wf.prepareBatchPreview();
      this.restoreAnchorGroup(anchorGroupId);
      return;
    }
    void this.wf.applyPlan();
  }

  batchApplyLabel(): string {
    const count = this.wf.planOperationCount();
    return this.wf.analysisDisplayMode() === 'preview'
      ? `应用计划 (${count} 项操作)`
      : `应用计划 (${count} 项操作) →`;
  }

  batchApplyDisabled(): boolean {
    if (this.wf.analysisDisplayMode() === 'preview') {
      return !this.wf.canApply();
    }
    return this.wf.planOperationCount() === 0 || this.wf.loading() || this.wf.applying();
  }

  groupSecretsVisible(group: { items: DuplicateItemView[] }): boolean {
    const credentialItems = group.items.filter((item) => item.credChips.some((chip) => chip.kind !== 'missing'));
    return credentialItems.length > 0 && credentialItems.every((item) => item.secretVisible);
  }

  fieldDifferent(group: DuplicateGroupView, key: DetailCompareFieldKey): boolean {
    return fieldIsDifferent(group, key);
  }

  detailTimeParts(item: DuplicateItemView): string[] {
    return [detailRowValue(item, 'created'), detailRowValue(item, 'updated')];
  }

  detailFields(group: DuplicateGroupView, item: DuplicateItemView): DetailCompareFieldView[] {
    const rows: Array<Omit<DetailCompareFieldView, 'different'>> = [
      { key: 'url', label: 'URL', value: item.url, tone: 'url' },
      { key: 'credentials', label: '凭据', value: credentialSummary(item), tone: 'credential' },
      { key: 'vault', label: '保险库', value: item.vaultName, tone: 'default' },
      { key: 'time', label: '时间', value: detailTimeValue(item), tone: 'default' },
      { key: 'category', label: '类型', value: item.categoryLabel, tone: 'default' },
      { key: 'tags', label: '标签', value: detailRowValue(item, 'tags'), tone: 'default' }
    ];

    return rows.map((row) => ({
      ...row,
      different: fieldIsDifferent(group, row.key)
    }));
  }

  private visibleAnchorGroupId(): string | undefined {
    const container = this.groupList?.nativeElement;
    if (!container) {
      return undefined;
    }
    const containerTop = container.getBoundingClientRect().top;
    const groups = Array.from(container.querySelectorAll<HTMLElement>('[data-group-id]'));
    return groups
      .map((element) => ({
        element,
        distance: Math.abs(element.getBoundingClientRect().top - containerTop)
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.element.dataset['groupId'];
  }

  private restoreAnchorGroup(groupId: string | undefined): void {
    if (!groupId) {
      return;
    }
    window.setTimeout(() => {
      const container = this.groupList?.nativeElement;
      const target = container?.querySelector<HTMLElement>(`[data-group-id="${cssEscape(groupId)}"]`);
      if (container && target) {
        container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top;
      }
    }, 0);
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}

function fieldIsDifferent(group: DuplicateGroupView, key: DetailCompareFieldKey): boolean {
  if (group.items.length < 2) {
    return false;
  }
  const values = new Set(group.items.map((item) => normalizeDetailValue(detailValue(item, key))));
  return values.size > 1;
}

function detailValue(item: DuplicateItemView, key: DetailCompareFieldKey): string {
  switch (key) {
    case 'username':
      return item.username;
    case 'title':
      return item.title;
    case 'url':
      return item.url;
    case 'credentials':
      return item.credentialSignature;
    case 'vault':
      return item.vaultName;
    case 'category':
      return item.categoryLabel;
    case 'time':
      return detailTimeValue(item);
    case 'tags':
      return detailRowValue(item, key);
  }
}

function detailRowValue(item: DuplicateItemView, key: ItemDetailFieldKey): string {
  return item.detailRows.find((row) => row.key === key)?.value || '—';
}

function detailTimeValue(item: DuplicateItemView): string {
  return `${detailRowValue(item, 'created')} ${detailRowValue(item, 'updated')}`;
}

function credentialSummary(item: DuplicateItemView): string {
  return item.credChips.map((chip) => `${chip.label}: ${chip.text}`).join(' / ');
}

function normalizeDetailValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
