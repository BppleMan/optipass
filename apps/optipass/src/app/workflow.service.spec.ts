import { signal } from '@angular/core';
import { vi } from 'vitest';
import type { DuplicateGroup, ItemSummary, ScanResult } from '@optimize-password/core';
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
