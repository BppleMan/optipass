import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OpButtonComponent } from '../op-button/op-button';
import { OpProgressComponent } from '../op-progress/op-progress';
import { OpTabsComponent } from '../op-tabs/op-tabs';
import { WorkflowService } from '../../workflow.service';
import type { DetailCompareFieldKey, DetailCompareFieldView, DuplicateGroupView, DuplicateItemView, DuplicateKind, ItemDetailFieldKey } from '../../models';

@Component({
  selector: 'op-analysis-page',
  standalone: true,
  imports: [FormsModule, OpButtonComponent, OpProgressComponent, OpTabsComponent],
  templateUrl: './analysis-page.html'
})
export class AnalysisPageComponent {
  activeDetailGroupId: string | undefined;

  constructor(readonly wf: WorkflowService) {}

  setKind(kind: DuplicateKind): void {
    this.closeGroupDetail();
    this.wf.setActiveKind(kind);
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

  hasPasswordItems(group: DuplicateGroupView): boolean {
    return group.items.some((item) => item.credChips.some((chip) => chip.kind === 'password'));
  }

  groupSecretsVisible(group: DuplicateGroupView): boolean {
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
