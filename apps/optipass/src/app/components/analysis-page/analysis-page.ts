import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OpButtonComponent } from '../op-button/op-button';
import { OpProgressComponent } from '../op-progress/op-progress';
import { OpTabsComponent } from '../op-tabs/op-tabs';
import { WorkflowService } from '../../workflow.service';
import type { DuplicateKind } from '../../models';

@Component({
  selector: 'op-analysis-page',
  standalone: true,
  imports: [FormsModule, OpButtonComponent, OpProgressComponent, OpTabsComponent],
  templateUrl: './analysis-page.html'
})
export class AnalysisPageComponent {
  constructor(readonly wf: WorkflowService) {}

  setKind(kind: DuplicateKind): void {
    this.wf.setActiveKind(kind);
  }
}
