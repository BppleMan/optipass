import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OpButtonComponent } from '../op-button/op-button';
import { OpProgressComponent } from '../op-progress/op-progress';
import { WorkflowService } from '../../workflow.service';

@Component({
  selector: 'op-scan-page',
  standalone: true,
  imports: [FormsModule, OpButtonComponent, OpProgressComponent],
  templateUrl: './scan-page.html'
})
export class ScanPageComponent {
  constructor(readonly wf: WorkflowService) {}

  scanButtonLabel(): string {
    if (this.wf.authState() === 'authorizing') {
      if (this.wf.activeScanMode() === 'mock') {
        return '扫描中';
      }
      return '等待授权…';
    }
    if (this.wf.authState() === 'authorized') {
      return '扫描中';
    }
    return '扫描';
  }

  scanControlsDisabled(): boolean {
    return this.wf.loading() || this.wf.authState() === 'authorizing' || this.wf.authState() === 'authorized';
  }
}
