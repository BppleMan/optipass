import { Component, ElementRef, HostListener, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OpButtonComponent } from '../op-button/op-button';
import { OpProgressComponent } from '../op-progress/op-progress';
import { OpTabsComponent } from '../op-tabs/op-tabs';
import { PlanActionGroupComponent } from './plan-action-group/plan-action-group';
import { VaultIconComponent } from '../vault-icon/vault-icon';
import { WorkflowService } from '../../workflow.service';
import type { AnalysisDisplayMode, DetailCompareFieldKey, DetailCompareFieldView, DuplicateGroupView, DuplicateItemView, DuplicateKind, ItemDetailFieldKey, RemoveAction, TabView, VaultOptionView } from '../../models';

@Component({
  selector: 'op-analysis-page',
  standalone: true,
  imports: [FormsModule, OpButtonComponent, OpProgressComponent, OpTabsComponent, PlanActionGroupComponent, VaultIconComponent],
  templateUrl: './analysis-page.html'
})
export class AnalysisPageComponent implements OnInit {
  readonly displayModeTabs: TabView[] = [
    { kind: 'edit', label: '编辑', color: '#82aaff', bg: 'rgba(130, 170, 255, 0.16)' },
    { kind: 'preview', label: '预览', color: '#82aaff', bg: 'rgba(130, 170, 255, 0.16)' }
  ];

  activeDetailGroupId: string | undefined;
  openActionMenuId: string | undefined;
  actionMenuFrame = { top: 0, left: 0, width: 180 };

  @ViewChild('groupList') private readonly groupList?: ElementRef<HTMLElement>;

  constructor(readonly wf: WorkflowService) {}

  ngOnInit(): void {
    void this.wf.restoreCachedState();
  }

  @HostListener('document:click')
  closeActionMenu(): void {
    this.openActionMenuId = undefined;
  }

  @HostListener('window:resize')
  closeActionMenuOnResize(): void {
    this.closeActionMenu();
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
  }

  toggleActionMenu(menuId: string, event: MouseEvent): void {
    event.stopPropagation();
    if (this.openActionMenuId === menuId) {
      this.openActionMenuId = undefined;
      return;
    }
    const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    const rect = trigger?.getBoundingClientRect();
    const width = Math.max(180, rect?.width ?? 0);
    this.actionMenuFrame = {
      top: (rect?.bottom ?? 0) + 5,
      left: Math.max(8, (rect?.right ?? width) - width),
      width
    };
    this.openActionMenuId = menuId;
  }

  selectTargetVault(item: DuplicateItemView, vaultId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.wf.updateTargetVault(item.id, vaultId);
    this.openActionMenuId = undefined;
  }

  selectRemoveAction(item: DuplicateItemView, action: RemoveAction, event: MouseEvent): void {
    event.stopPropagation();
    this.wf.updateRemoveAction(item.id, action);
    this.openActionMenuId = undefined;
  }

  selectedVaultOption(item: DuplicateItemView): VaultOptionView {
    return item.vaultOptions.find((vault) => vault.id === item.targetVault)
      ?? item.vaultOptions[0]
      ?? { id: item.vaultId, label: item.vaultName, name: item.vaultName, current: true };
  }

  removeActionLabel(action: RemoveAction): string {
    return action === 'delete' ? '删除' : '归档（可恢复）';
  }

  removeActionIcon(action: RemoveAction): string {
    return action === 'delete' ? '×' : '↧';
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

  hasPasswordItems(group: { items: DuplicateItemView[] }): boolean {
    return group.items.some((item) => item.credChips.some((chip) => chip.kind === 'password'));
  }

  groupSecretsVisible(group: { items: DuplicateItemView[] }): boolean {
    const passwordItems = group.items.filter((item) => item.credChips.some((chip) => chip.kind === 'password'));
    return passwordItems.length > 0 && passwordItems.every((item) => item.secretVisible);
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
