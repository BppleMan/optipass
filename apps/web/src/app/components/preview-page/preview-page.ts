import { Component } from '@angular/core';
import { OpButtonComponent } from '../op-button/op-button';
import { OpProgressComponent } from '../op-progress/op-progress';
import { OpTabsComponent } from '../op-tabs/op-tabs';
import { WorkflowService } from '../../workflow.service';
import type { DuplicateKind } from '../../models';

@Component({
  selector: 'op-preview-page',
  standalone: true,
  imports: [OpButtonComponent, OpProgressComponent, OpTabsComponent],
  templateUrl: './preview-page.html'
})
export class PreviewPageComponent {
  constructor(readonly wf: WorkflowService) {}

  setKind(kind: DuplicateKind): void {
    this.wf.setPreviewKind(kind);
  }
}
