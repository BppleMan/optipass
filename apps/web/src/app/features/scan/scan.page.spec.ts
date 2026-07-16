import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ScanPageComponent } from './scan.page';
import { ItemProvider, ScanPhase } from '@optimize-password/core';

describe('ScanPageComponent', () => {
  let component: ScanPageComponent;
  let fixture: ComponentFixture<ScanPageComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ScanPageComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ScanPageComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('shows the final scan duration', () => {
    component.wf.setScanProgress({
      scanId: 'scan-1',
      phase: ScanPhase.Completed,
      startedAt: '2026-07-15T10:00:00.000Z',
      finishedAt: '2026-07-15T10:01:05.000Z',
      totalVaults: 1,
      scannedVaults: 1,
      totalItems: 1,
      scannedItems: 1,
      vaults: []
    });

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('01:05');
    expect(fixture.nativeElement.textContent).toContain('扫描耗时');
  });

  it('shows zero completion before authorization discovers any items', () => {
    component.wf.setScanProgress({
      scanId: 'scan-1',
      phase: ScanPhase.Scanning,
      totalVaults: 0,
      scannedVaults: 0,
      totalItems: 0,
      scannedItems: 0,
      vaults: []
    });

    expect(component.displayOverallPct()).toBe(0);
  });

  it('only shows one hundred percent after the scan completes', () => {
    component.wf.setScanProgress({
      scanId: 'scan-1',
      phase: ScanPhase.Scanning,
      totalVaults: 1,
      scannedVaults: 0,
      totalItems: 10,
      scannedItems: 10,
      vaults: []
    });
    expect(component.displayOverallPct()).toBe(99);

    component.wf.setScanProgress({
      ...component.wf.scanProgress()!,
      phase: ScanPhase.Completed,
      scannedVaults: 1
    });
    expect(component.displayOverallPct()).toBe(100);
  });

  it('does not show a rescan button', () => {
    fixture.detectChanges();

    const buttons = Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('button'));
    expect(buttons.some((button) => button.textContent?.includes('重新扫描'))).toBe(false);
  });

  it('shows a local file picker for the CSV source', () => {
    component.wf.selectScanSource(ItemProvider.Csv);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('input[type="file"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('input[name="account"]')).toBeNull();
  });
});
