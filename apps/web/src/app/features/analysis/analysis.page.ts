import { afterNextRender, AfterViewChecked, ChangeDetectionStrategy, Component, ElementRef, Injector, OnInit, ViewChild } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ItemDisposition } from "@optimize-password/core";
import { ApplyStatus, RemoveAction, TagRemovalScope, type DuplicateGroupView, type DuplicateItemView } from "../../core/models/workflow.models";
import { ItemTypeIconComponent } from "../../shared/ui/item-type-icon/item-type-icon";
import { resolveItemTypeIcon } from "../../shared/library/icon-library";
import { OpButtonComponent } from "../../shared/ui/op-button/op-button";
import { OpProgressComponent } from "../../shared/ui/op-progress/op-progress";
import { SegmentedControlComponent, SegmentedControlIcon, type SegmentedControlItem } from "../../shared/ui/segmented-control/segmented-control";
import { VaultIconComponent } from "../../shared/ui/vault-icon/vault-icon";
import { AnalysisEmptyStateComponent } from "./components/analysis-empty-state/analysis-empty-state";
import { AnalysisItemMatrix } from "./components/analysis-item-matrix/analysis-item-matrix";
import { SearchMoveDirection, WorkflowService } from "./state/workflow.service";

enum GroupRemovalMode {
  Archive = "archive",
  Delete = "delete",
  Manual = "manual",
}

@Component({
  selector: "op-analysis-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AnalysisEmptyStateComponent, AnalysisItemMatrix, FormsModule, ItemTypeIconComponent, OpButtonComponent, OpProgressComponent, SegmentedControlComponent, VaultIconComponent],
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
    { value: 'keep', label: '保留', icon: SegmentedControlIcon.Keep, activeColor: '#C3E88D', activeBackground: 'rgba(195, 232, 141, 0.16)' },
    { value: 'archive', label: '归档（可恢复）', icon: SegmentedControlIcon.Archive, activeColor: '#FFCB6B', activeBackground: 'rgba(255, 203, 107, 0.16)' },
    { value: 'delete', label: '永久删除', icon: SegmentedControlIcon.Delete, activeColor: '#FFB8C3', activeBackground: 'rgba(255, 83, 112, 0.16)' },
  ];
  readonly groupRemovalItems: SegmentedControlItem[] = [
    { value: 'archive', label: '本组统一归档', icon: SegmentedControlIcon.Archive, activeColor: '#FFCB6B', activeBackground: 'rgba(255, 203, 107, 0.16)' },
    { value: 'delete', label: '本组统一删除', icon: SegmentedControlIcon.Delete, activeColor: '#FFB8C3', activeBackground: 'rgba(255, 83, 112, 0.16)' },
    { value: 'manual', label: '手动处理', icon: SegmentedControlIcon.Manual, activeColor: '#82AAFF', activeBackground: 'rgba(130, 170, 255, 0.16)', disabled: true },
  ];
  tagScopePrompt?: { groupId: string; itemId: string; tag: string; eligibleCount: number };

  @ViewChild('applyOperationList') private readonly applyOperationList?: ElementRef<HTMLElement>;
  @ViewChild("globalSearchSuggestions") private readonly globalSearchSuggestions?: ElementRef<HTMLElement>;
  private followedOperationId?: string;
  private followApplyProgress = true;

  constructor(
    readonly wf: WorkflowService,
    private readonly injector?: Injector,
  ) {}

  ngOnInit(): void {
    void this.wf.restoreCachedState();
  }

  ngAfterViewChecked(): void {
    const operations = this.wf.operations();
    const followedOperation = operations.find((operation) => operation.status === ApplyStatus.Running)
      ?? [...operations].reverse().find((operation) => operation.status === ApplyStatus.Done ||
        operation.status === ApplyStatus.Failed || operation.status === ApplyStatus.Skipped);
    if (!followedOperation) {
      this.followedOperationId = undefined;
      this.followApplyProgress = true;
      return;
    }
    if (followedOperation.id === this.followedOperationId) {
      return;
    }
    this.followedOperationId = followedOperation.id;
    if (this.injector) {
      afterNextRender(() => this.scrollApplyProgressToOperation(followedOperation.id), { injector: this.injector });
      return;
    }
    queueMicrotask(() => this.scrollApplyProgressToOperation(followedOperation.id));
  }

  public onGlobalSearchKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (this.wf.globalSearchAutocompleteOpen()) {
        this.wf.moveGlobalSearchSuggestion(SearchMoveDirection.Next);
      } else {
        this.wf.activateGlobalSearchSuggestion(0);
        this.wf.openGlobalSearchAutocomplete();
      }
      queueMicrotask(() => this.scrollActiveGlobalSearchSuggestionIntoView());
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.wf.moveGlobalSearchSuggestion(SearchMoveDirection.Previous);
      queueMicrotask(() => this.scrollActiveGlobalSearchSuggestionIntoView());
      return;
    }
    if (event.key === "Enter" && this.wf.globalSearchAutocompleteOpen()) {
      event.preventDefault();
      this.wf.selectActiveGlobalSearchSuggestion();
      return;
    }
    if (event.key === "Escape") {
      this.wf.closeGlobalSearchAutocomplete();
    }
  }

  public onGlobalSearchFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !(event.currentTarget as HTMLElement).contains(next)) {
      this.wf.closeGlobalSearchAutocomplete();
    }
  }

  private scrollActiveGlobalSearchSuggestionIntoView(): void {
    this.globalSearchSuggestions?.nativeElement
      .querySelector<HTMLElement>(".global-search-suggestion.active")
      ?.scrollIntoView({ block: "nearest" });
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

  applyTagScope(scope: TagRemovalScope): void {
    const prompt = this.tagScopePrompt;
    if (!prompt) {
      return;
    }
    if (scope === TagRemovalScope.Group) {
      this.wf.removeTagFromGroup(prompt.groupId, prompt.tag);
    } else {
      this.wf.toggleTagRemoval(prompt.itemId, prompt.tag);
    }
    this.tagScopePrompt = undefined;
  }

  setItemDecision(item: DuplicateItemView, disposition: ItemDisposition): void {
    this.wf.updateKeep(item.id, disposition === ItemDisposition.Keep);
    if (disposition === ItemDisposition.Archive) {
      this.wf.updateRemoveAction(item.id, RemoveAction.Archive);
    } else if (disposition === ItemDisposition.Delete) {
      this.wf.updateRemoveAction(item.id, RemoveAction.Delete);
    }
  }

  onItemDecisionChange(item: DuplicateItemView, value: string): void {
    if (value === 'keep' || value === 'archive' || value === 'delete') {
      this.setItemDecision(item, value as ItemDisposition);
    }
  }

  groupRemovalMode(group: DuplicateGroupView): GroupRemovalMode {
    const removable = group.items.filter((item) => !item.keep);
    if (removable.length === 0) {
      return GroupRemovalMode.Manual;
    }
    const first = removable[0].removeAction;
    if (!removable.every((item) => item.removeAction === first)) {
      return GroupRemovalMode.Manual;
    }
    return first === RemoveAction.Delete ? GroupRemovalMode.Delete : GroupRemovalMode.Archive;
  }

  setGroupRemovalMode(group: DuplicateGroupView, mode: RemoveAction): void {
    this.wf.updateGroupRemoveAction(group.id, mode);
  }

  onGroupRemovalChange(group: DuplicateGroupView, value: string): void {
    if (value === 'archive' || value === 'delete') {
      this.setGroupRemovalMode(group, value === 'delete' ? RemoveAction.Delete : RemoveAction.Archive);
    }
  }

  handleBatchApply(): void {
    if (this.wf.applying()) {
      this.wf.openApplyDialog();
      return;
    }
    void this.wf.applyPlan();
  }

  public requestStopActionExecution(): void {
    if (window.confirm("停止后，当前操作会执行完，已完成的真实写入不会回滚。确定停止吗？")) {
      void this.wf.stopActionExecution();
    }
  }

  batchApplyLabel(): string {
    if (this.wf.applying()) {
      return `${this.wf.actionExecutionStatusLabel()} · 查看进度`;
    }
    return `应用计划 (${this.wf.planOperationCount()} 项操作)`;
  }

  batchApplyDisabled(): boolean {
    if (this.wf.applying()) {
      return this.wf.applyDialogOpen();
    }
    return !this.wf.canApply();
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

  private scrollApplyProgressToOperation(operationId: string): void {
    const list = this.applyOperationList?.nativeElement;
    if (!list || !this.followApplyProgress) {
      return;
    }
    list.querySelector<HTMLElement>(`[data-operation-id="${cssEscape(operationId)}"]`)?.scrollIntoView({ block: "nearest" });
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}
