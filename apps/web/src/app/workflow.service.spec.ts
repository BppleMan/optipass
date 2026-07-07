import { signal } from '@angular/core';
import { vi } from 'vitest';
import type { DuplicateGroup, ItemSummary, ScanProgress, ScanResult, ScanSnapshot } from '@optimize-password/core';
import { WorkflowService } from './workflow.service';

describe('WorkflowService analysis filters', () => {
  it('uses OR within one filter section and AND across different sections', () => {
    const service = createService();
    service.scanResult.set(scanResult());

    expect(service.visibleGroups().map((group) => group.id)).toEqual(['github-group', 'apple-group']);

    service.toggleAnalysisFilter('years', '2025', true);
    expect(service.visibleGroups().map((group) => group.id)).toEqual(['github-group']);

    service.toggleAnalysisFilter('years', '2023', true);
    expect(service.visibleGroups().map((group) => group.id)).toEqual(['github-group', 'apple-group']);

    service.toggleAnalysisFilter('domains', 'apple.com', true);
    expect(service.visibleGroups().map((group) => group.id)).toEqual(['apple-group']);

    service.toggleAnalysisFilter('credentials', 'password', true);
    expect(service.visibleGroups()).toHaveLength(0);

    service.toggleAnalysisFilter('credentials', 'passkey', true);
    expect(service.visibleGroups().map((group) => group.id)).toEqual(['apple-group']);
  });

  it('exposes removable chips and clears filters on kind changes', () => {
    const service = createService();
    service.scanResult.set(scanResult());

    service.toggleAnalysisFilter('years', '2025', true);
    service.toggleAnalysisFilter('vaults', 'icloud', true);

    expect(service.analysisFilterSummary().chips.map((chip) => chip.label)).toEqual(['2025', 'iCloud']);

    service.removeAnalysisFilter('year', '2025');
    expect(service.analysisFilterSummary().chips.map((chip) => chip.label)).toEqual(['iCloud']);

    service.setActiveKind('identical');
    expect(service.analysisFilterSummary().chips).toEqual([]);
  });

  it('clears backend scan state before returning to the scan page', async () => {
    const clearScan = vi.fn(async () => ({ ok: true }));
    const navigateByUrl = vi.fn();
    const service = createService({ clearScan, navigateByUrl });
    service.scanResult.set(scanResult());
    service.error.set('old error');

    await service.rescan();

    expect(clearScan).toHaveBeenCalledTimes(1);
    expect(service.scanResult()).toBeUndefined();
    expect(service.error()).toBeUndefined();
    expect(navigateByUrl).toHaveBeenCalledWith('/scan');
  });

  it('recovers a completed scan when the progress stream fails', async () => {
    const session = signal<unknown>(undefined);
    const scan = scanSnapshot();
    const service = new WorkflowService(
      {
        session,
        loadSession: vi.fn(async () => {
          const value = {
            token: 'test-session',
            accountName: 'BppleMan',
            hasServiceAccountToken: false
          };
          session.set(value);
          return value;
        }),
        startScan: vi.fn(async () => ({
          scanId: scan.scanId,
          mode: 'live',
          progress: scanProgress(scan.scanId),
          eventsToken: 'events-token'
        })),
        streamScanEvents: vi.fn(async () => {
          throw new Error('Load failed');
        }),
        loadScan: vi.fn(async () => scan)
      } as never,
      { navigateByUrl: vi.fn() } as never
    );

    service.updateAccount('BppleMan');
    await service.startScan();

    expect(service.authState()).toBe('authorized');
    expect(service.error()).toBeUndefined();
    expect(service.scanSnapshot()).toEqual(scan);
    expect(service.scanDone()).toBe(true);
  });
});

function createService(overrides: {
  clearScan?: () => Promise<{ ok: boolean }>;
  navigateByUrl?: (url: string) => Promise<boolean>;
} = {}): WorkflowService {
  return new WorkflowService(
    {
      session: signal({ token: 'test-session' }),
      clearScan: overrides.clearScan ?? vi.fn(async () => ({ ok: true }))
    } as never,
    { navigateByUrl: overrides.navigateByUrl ?? vi.fn() } as never
  );
}

function scanResult(): ScanResult {
  const items = [
    item({
      id: 'icloud:github-new',
      vaultId: 'icloud',
      vaultName: 'iCloud',
      title: 'GitHub',
      urls: ['https://github.com/login'],
      usernames: ['alice@example.com'],
      updatedAt: '2025-04-01T00:00:00.000Z',
      hasPassword: true
    }),
    item({
      id: 'private:github-old',
      vaultId: 'private',
      vaultName: 'Private',
      title: 'GitHub old',
      urls: ['github.com/login'],
      usernames: ['alice@example.com'],
      updatedAt: '2024-04-01T00:00:00.000Z',
      hasTotp: true
    }),
    item({
      id: 'private:apple-new',
      vaultId: 'private',
      vaultName: 'Private',
      title: 'Apple',
      urls: ['https://apple.com/login'],
      usernames: ['alice@example.com'],
      updatedAt: '2023-04-01T00:00:00.000Z',
      hasPasskey: true
    }),
    item({
      id: 'chrome:apple-old',
      vaultId: 'chrome',
      vaultName: 'Chrome',
      title: 'Apple old',
      urls: ['apple.com/login'],
      usernames: ['alice@example.com'],
      updatedAt: '2023-01-01T00:00:00.000Z',
      hasPasskey: true
    })
  ];

  return {
    scanId: 'scan-test',
    scannedAt: '2026-01-01T00:00:00.000Z',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    vaults: [
      { id: 'icloud', name: 'iCloud' },
      { id: 'private', name: 'Private' },
      { id: 'chrome', name: 'Chrome' }
    ],
    items,
    groups: [
      group('github-group', ['icloud:github-new', 'private:github-old']),
      group('apple-group', ['private:apple-new', 'chrome:apple-old'])
    ]
  };
}

function scanSnapshot(): ScanSnapshot {
  const result = scanResult();
  return {
    scanId: result.scanId,
    scannedAt: result.scannedAt,
    vaults: result.vaults,
    items: result.items
  };
}

function scanProgress(scanId: string): ScanProgress {
  return {
    scanId,
    phase: 'scanning',
    totalVaults: 0,
    scannedVaults: 0,
    totalItems: 0,
    scannedItems: 0,
    vaults: [],
    message: '正在等待 1Password 授权。'
  };
}

function group(id: string, itemIds: string[]): DuplicateGroup {
  return {
    id,
    candidateClass: 'similar-login',
    itemIds,
    reasons: [],
    recommendedKeepIds: [itemIds[0]],
    recommendedKeepReasons: [],
    confidence: 'high'
  };
}

function item(overrides: Partial<ItemSummary> & Pick<ItemSummary, 'id' | 'title'>): ItemSummary {
  return {
    onePasswordItemId: overrides.id,
    vaultId: 'private',
    vaultName: 'Private',
    category: 'login',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    urls: [],
    usernames: [],
    tags: [],
    fieldCount: 2,
    hasPassword: false,
    hasTotp: false,
    hasPasskey: false,
    hasAttachments: false,
    hasNotes: false,
    comparableFields: [],
    ...overrides
  };
}
