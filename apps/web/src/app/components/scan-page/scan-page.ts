import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OpButtonComponent } from '../op-button/op-button';
import { OpProgressComponent } from '../op-progress/op-progress';
import { VaultIconComponent } from '../vault-icon/vault-icon';
import { WorkflowService } from '../../workflow.service';

@Component({
  selector: 'op-scan-page',
  standalone: true,
  imports: [FormsModule, OpButtonComponent, OpProgressComponent, VaultIconComponent],
  templateUrl: './scan-page.html'
})
export class ScanPageComponent implements OnInit {
  errorDialogOpen = false;

  constructor(readonly wf: WorkflowService) {}

  ngOnInit(): void {
    void this.wf.restoreCachedState();
  }

  scanButtonLabel(): string {
    if (this.wf.scanDone()) {
      return '扫描';
    }
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
    return !this.wf.scanDone() && (this.wf.loading() || this.wf.authState() === 'authorizing' || this.wf.authState() === 'authorized');
  }

  rescanDisabled(): boolean {
    return !this.scanInProgress() && !this.wf.scanRows().length && !this.wf.scanDone() && !this.wf.scanFailed();
  }

  scanInProgress(): boolean {
    if (this.wf.scanDone()) {
      return false;
    }
    const phase = this.wf.scanProgress()?.phase;
    return this.wf.loading() || phase === 'scanning';
  }

  scanStatusLabel(): string {
    if (this.wf.scanDone()) {
      return '扫描完成';
    }
    if (this.scanInProgress()) {
      return '扫描中';
    }
    if (this.wf.scanFailed()) {
      return '扫描失败';
    }
    return '等待扫描';
  }

  scanStatusTone(): 'waiting' | 'scanning' | 'done' | 'failed' {
    if (this.wf.scanDone()) {
      return 'done';
    }
    if (this.scanInProgress()) {
      return 'scanning';
    }
    if (this.wf.scanFailed()) {
      return 'failed';
    }
    return 'waiting';
  }

  scanProgressColor(): string {
    switch (this.scanStatusTone()) {
      case 'done':
        return '#c3e88d';
      case 'scanning':
        return '#82aaff';
      case 'failed':
        return '#ff5370';
      case 'waiting':
        return '#616161';
    }
  }

  openErrorDialog(): void {
    if (this.wf.error()) {
      this.errorDialogOpen = true;
    }
  }

  closeErrorDialog(): void {
    this.errorDialogOpen = false;
  }

  scanStatusDetail(): string {
    if (this.wf.scanDone()) {
      return ` · 已将 ${this.wf.totalItems()} 个 item 读入本地内存`;
    }
    if (this.wf.scanFailed()) {
      return ' · 请检查授权状态后重新扫描';
    }
    return '';
  }
}
