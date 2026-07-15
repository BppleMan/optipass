import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ScanPageComponent } from './scan.page';

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
    component.wf.scanProgress.set({
      scanId: 'scan-1',
      phase: 'completed',
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

  it('does not show a rescan button', () => {
    fixture.detectChanges();

    const buttons = Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('button'));
    expect(buttons.some((button) => button.textContent?.includes('重新扫描'))).toBe(false);
  });
});
