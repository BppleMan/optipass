import { Component, HostListener, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OpButtonComponent } from '../op-button/op-button';
import { OpProgressComponent } from '../op-progress/op-progress';
import { OpTabsComponent } from '../op-tabs/op-tabs';
import { WorkflowService } from '../../workflow.service';
import type { DuplicateKind, ItemDetailFieldKey } from '../../models';

@Component({
  selector: 'op-analysis-page',
  standalone: true,
  imports: [FormsModule, OpButtonComponent, OpProgressComponent, OpTabsComponent],
  templateUrl: './analysis-page.html'
})
export class AnalysisPageComponent implements OnDestroy {
  activeDetailField: ItemDetailFieldKey | undefined;
  activeDetailGroupId: string | undefined;
  private detailCloseTimer: number | undefined;

  constructor(readonly wf: WorkflowService) {}

  ngOnDestroy(): void {
    this.clearDetailCloseTimer();
  }

  setKind(kind: DuplicateKind): void {
    this.closeGroupDetail();
    this.wf.setActiveKind(kind);
  }

  openGroupDetail(groupId: string): void {
    this.clearDetailCloseTimer();
    this.activeDetailGroupId = groupId;
  }

  scheduleGroupDetailClose(groupId: string, delayMs = 120): void {
    this.clearDetailCloseTimer();
    this.detailCloseTimer = window.setTimeout(() => {
      if (this.activeDetailGroupId === groupId) {
        this.closeGroupDetail();
      }
    }, delayMs);
  }

  setDetailField(field: ItemDetailFieldKey): void {
    this.activeDetailField = field;
  }

  clearDetailField(field: ItemDetailFieldKey): void {
    if (this.activeDetailField === field) {
      this.activeDetailField = undefined;
    }
  }

  @HostListener('document:pointermove', ['$event'])
  onDocumentPointerMove(event: PointerEvent): void {
    const activeGroupId = this.activeDetailGroupId;
    if (!activeGroupId) {
      return;
    }

    const targetZone = this.detailTargetZone(event.target, activeGroupId);
    if (targetZone === 'detail') {
      this.clearDetailCloseTimer();
      return;
    }

    if (targetZone === 'same-card') {
      this.scheduleGroupDetailClose(activeGroupId, 80);
      return;
    }

    this.closeGroupDetail();
  }

  @HostListener('document:mouseleave')
  @HostListener('window:blur')
  closeGroupDetailFromBoundary(): void {
    this.closeGroupDetail();
  }

  @HostListener('document:mouseout', ['$event'])
  onDocumentMouseOut(event: MouseEvent): void {
    if (!event.relatedTarget) {
      this.closeGroupDetail();
    }
  }

  @HostListener('document:wheel', ['$event'])
  onDocumentWheel(event: WheelEvent): void {
    const activeGroupId = this.activeDetailGroupId;
    if (!activeGroupId || this.detailTargetZone(event.target, activeGroupId) === 'detail') {
      return;
    }

    this.closeGroupDetail();
  }

  private closeGroupDetail(): void {
    this.activeDetailGroupId = undefined;
    this.activeDetailField = undefined;
    this.clearDetailCloseTimer();
  }

  private clearDetailCloseTimer(): void {
    if (this.detailCloseTimer !== undefined) {
      window.clearTimeout(this.detailCloseTimer);
      this.detailCloseTimer = undefined;
    }
  }

  private detailTargetZone(target: EventTarget | null, groupId: string): 'detail' | 'same-card' | 'outside' {
    if (!(target instanceof Element)) {
      return 'outside';
    }

    const groupCard = target.closest<HTMLElement>('[data-detail-group-id]');
    if (!groupCard || groupCard.dataset['detailGroupId'] !== groupId) {
      return 'outside';
    }

    return target.closest('.identity-cell, .group-detail-popover') ? 'detail' : 'same-card';
  }
}
