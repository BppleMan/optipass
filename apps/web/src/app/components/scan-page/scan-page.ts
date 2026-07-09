import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthToastBridgeComponent } from '../auth-toast-bridge/auth-toast-bridge';
import { OpButtonComponent } from '../op-button/op-button';
import { OpProgressComponent } from '../op-progress/op-progress';
import { VaultIconComponent } from '../vault-icon/vault-icon';
import { WorkflowService } from '../../workflow.service';

@Component({
  selector: 'op-scan-page',
  standalone: true,
  imports: [FormsModule, AuthToastBridgeComponent, OpButtonComponent, OpProgressComponent, VaultIconComponent],
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

  connectionTitle(): string {
    const account = this.wf.account().trim() || '1Password';
    if (this.wf.scanDone()) {
      return `已连接 ${account}`;
    }
    if (this.scanInProgress()) {
      return `正在扫描 ${account}`;
    }
    if (this.wf.scanFailed()) {
      return `连接异常 ${account}`;
    }
    return `准备连接 ${account}`;
  }

  connectionIcon(): string {
    switch (this.scanStatusTone()) {
      case 'done':
        return '✓';
      case 'scanning':
        return '◌';
      case 'failed':
        return '!';
      case 'waiting':
        return '○';
    }
  }

  totalVaults(): number {
    return this.wf.scanProgress()?.totalVaults || this.wf.scanData()?.vaults.length || 0;
  }

  scannedVaults(): number {
    if (this.wf.scanDone()) {
      return this.wf.scanRows().length;
    }
    return this.wf.scanRows().filter((vault) => vault.started).length;
  }

  failedVaults(): number {
    return 0;
  }

  displayOverallPct(): number {
    if (!this.wf.scanProgress() && !this.wf.scanData()) {
      return 0;
    }
    return this.wf.overallPct();
  }

  summaryMetrics(): Array<{ label: string; value: string; icon: string; color: string }> {
    return [
      { label: '总 items', value: String(this.wf.totalItems()), icon: '▰', color: '#82aaff' },
      { label: '已扫描 vault', value: String(this.scannedVaults()), icon: '□', color: '#c3e88d' },
      { label: '异常 vault', value: String(this.failedVaults()), icon: '▱', color: '#c792ea' },
      { label: '扫描完成', value: `${this.displayOverallPct()}%`, icon: '✓', color: '#ffcb6b' }
    ];
  }

  statusIcon(status: string): string {
    if (status.includes('完成')) {
      return '✓';
    }
    if (status.includes('扫描')) {
      return '◌';
    }
    return '○';
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
