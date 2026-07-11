import { afterNextRender, AfterViewChecked, ChangeDetectionStrategy, Component, ElementRef, Injector, OnInit, ViewChild } from "@angular/core";
import { FormsModule } from "@angular/forms";
import type { AnalysisDisplayMode, DuplicateGroupView, DuplicateItemView, DuplicateKind, RemoveAction, TabView } from "../../core/models/workflow.models";
import { ItemTypeIconComponent } from "../../shared/ui/item-type-icon/item-type-icon";
import { resolveItemTypeIcon } from "../../shared/library/icon-library";
import { OpButtonComponent } from "../../shared/ui/op-button/op-button";
import { OpProgressComponent } from "../../shared/ui/op-progress/op-progress";
import { SegmentedControlComponent, type SegmentedControlItem } from "../../shared/ui/segmented-control/segmented-control";
import { OpTabsComponent } from "../../shared/ui/op-tabs/op-tabs";
import { VaultIconComponent } from "../../shared/ui/vault-icon/vault-icon";
import { AnalysisItemMatrix } from "./components/analysis-item-matrix/analysis-item-matrix";
import { PlanActionGroupComponent } from "./components/plan-action-group/plan-action-group";
import { WorkflowService } from "./state/workflow.service";

type GroupRemovalMode = RemoveAction | 'manual';

@Component({
  selector: "op-analysis-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AnalysisItemMatrix, FormsModule, ItemTypeIconComponent, OpButtonComponent, OpProgressComponent, SegmentedControlComponent, OpTabsComponent, PlanActionGroupComponent, VaultIconComponent],
  templateUrl: "./analysis.page.html",
  styleUrls: [
    "./analysis.page.scss",
    "./analysis-filters.scss",
    "./analysis-list.scss",
    "./analysis-dialogs.scss",
  ],
})
export class AnalysisPageComponent implements AfterViewChecked, OnInit {
  readonly itemDecisionItems: SegmentedControlItem[] = [
    { value: 'keep', label: '保留', icon: 'keep', activeColor: '#C3E88D', activeBackground: 'rgba(195, 232, 141, 0.16)' },
    { value: 'archive', label: '归档（可恢复）', icon: 'archive', activeColor: '#FFCB6B', activeBackground: 'rgba(255, 203, 107, 0.16)' },
    { value: 'delete', label: '永久删除', icon: 'delete', activeColor: '#FFB8C3', activeBackground: 'rgba(255, 83, 112, 0.16)' },
  ];
  readonly groupRemovalItems: SegmentedControlItem[] = [
    { value: 'archive', label: '本组统一归档', icon: 'archive', activeColor: '#FFCB6B', activeBackground: 'rgba(255, 203, 107, 0.16)' },
    { value: 'delete', label: '本组统一删除', icon: 'delete', activeColor: '#FFB8C3', activeBackground: 'rgba(255, 83, 112, 0.16)' },
    { value: 'manual', label: '手动处理', icon: 'manual', activeColor: '#82AAFF', activeBackground: 'rgba(130, 170, 255, 0.16)', disabled: true },
  ];
  readonly displayModeTabs: TabView[] = [
    { kind: 'edit', label: '编辑', color: '#c792ea', bg: 'rgba(199, 146, 234, 0.16)' },
    { kind: 'preview', label: '预览', color: '#c792ea', bg: 'rgba(199, 146, 234, 0.16)' }
  ];

  tagScopePrompt: { groupId: string; itemId: string; tag: string; eligibleCount: number } | undefined;

  @ViewChild('groupList') private readonly groupList?: ElementRef<HTMLElement>;
  @ViewChild('applyOperationList') private readonly applyOperationList?: ElementRef<HTMLElement>;
  private completedOperationCount = 0;
  private followApplyProgress = true;

  constructor(
    readonly wf: WorkflowService,
    private readonly injector?: Injector,
  ) {}

  ngOnInit(): void {
    void this.wf.restoreCachedState();
  }

  ngAfterViewChecked(): void {
    const completed = this.wf.operations().filter((operation) =>
      operation.status === "done" || operation.status === "failed" || operation.status === "skipped"
    ).length;
    if (completed === 0) {
      this.completedOperationCount = 0;
      this.followApplyProgress = true;
      return;
    }
    if (completed <= this.completedOperationCount) {
      return;
    }
    this.completedOperationCount = completed;
    if (this.injector) {
      afterNextRender(() => this.scrollApplyProgressToLatest(), { injector: this.injector });
      return;
    }
    queueMicrotask(() => this.scrollApplyProgressToLatest());
  }

  setKind(kind: string): void {
    this.wf.setActiveKind(kind as DuplicateKind);
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

  setItemDecision(item: DuplicateItemView, mode: 'keep' | RemoveAction): void {
    this.wf.updateKeep(item.id, mode === 'keep');
    if (mode !== 'keep') {
      this.wf.updateRemoveAction(item.id, mode);
    }
  }

  onItemDecisionChange(item: DuplicateItemView, value: string): void {
    if (value === 'keep' || value === 'archive' || value === 'delete') {
      this.setItemDecision(item, value);
    }
  }

  groupRemovalMode(group: DuplicateGroupView): GroupRemovalMode {
    const removable = group.items.filter((item) => !item.keep);
    if (removable.length === 0) {
      return 'manual';
    }
    const first = removable[0].removeAction;
    return removable.every((item) => item.removeAction === first) ? first : 'manual';
  }

  setGroupRemovalMode(group: DuplicateGroupView, mode: RemoveAction): void {
    this.wf.updateGroupRemoveAction(group.id, mode);
  }

  onGroupRemovalChange(group: DuplicateGroupView, value: string): void {
    if (value === 'archive' || value === 'delete') {
      this.setGroupRemovalMode(group, value);
    }
  }

  switchDisplayMode(mode: string): void {
    const displayMode = mode as AnalysisDisplayMode;
    if (this.wf.analysisDisplayMode() === displayMode) {
      return;
    }
    const anchorGroupId = this.visibleAnchorGroupId();
    this.wf.setAnalysisDisplayMode(displayMode);
    this.restoreAnchorGroup(anchorGroupId);
  }

  handleBatchApply(): void {
    if (this.wf.analysisDisplayMode() !== 'preview') {
      const anchorGroupId = this.visibleAnchorGroupId();
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

  onApplyOperationListScroll(): void {
    const list = this.applyOperationList?.nativeElement;
    if (!list) {
      return;
    }
    this.followApplyProgress = list.scrollHeight - list.clientHeight - list.scrollTop <= 12;
  }

  groupSecretsVisible(group: { items: DuplicateItemView[] }): boolean {
    const credentialItems = group.items.filter((item) => item.credChips.some((chip) => chip.kind !== 'missing'));
    return credentialItems.length > 0 && credentialItems.every((item) => item.secretVisible);
  }

  groupCategory(group: { items: DuplicateItemView[] }): string {
    return group.items[0]?.category ?? "unknown";
  }

  groupCategoryLabel(group: { items: DuplicateItemView[] }): string {
    return group.items[0]?.categoryLabel ?? "未知类型";
  }

  groupCategoryColor(group: { items: DuplicateItemView[] }): string {
    return resolveItemTypeIcon(this.groupCategory(group)).color;
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

  private scrollApplyProgressToLatest(): void {
    const list = this.applyOperationList?.nativeElement;
    if (!list || !this.followApplyProgress) {
      return;
    }
    list.scrollTop = list.scrollHeight - list.clientHeight;
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}
