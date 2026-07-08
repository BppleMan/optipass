import { signal } from '@angular/core';
import { vi } from 'vitest';
import { createExecutionPlan, type DuplicateGroup, type GroupDecision, type ItemSummary, type ScanProgress, type ScanResult, type ScanSnapshot } from '@optimize-password/core';
import type { ExecuteResponse } from './api.service';
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

  it('limits batch preview and apply operations to currently filtered groups', () => {
    const service = createService();
    service.scanResult.set(scanResult());
    service.decisions.set({
      'icloud:github-new': { itemId: 'icloud:github-new', keep: true, targetVaultId: 'icloud', deleteMode: 'archive' },
      'private:github-old': { itemId: 'private:github-old', keep: false, targetVaultId: 'private', deleteMode: 'archive' },
      'private:apple-new': { itemId: 'private:apple-new', keep: true, targetVaultId: 'private', deleteMode: 'archive' },
      'chrome:apple-old': { itemId: 'chrome:apple-old', keep: false, targetVaultId: 'chrome', deleteMode: 'archive' }
    });

    expect(service.planOperationCount()).toBe(2);

    service.toggleAnalysisFilter('vaults', 'icloud', true);
    service.prepareBatchPreview();

    expect(service.visiblePreviewGroups().map((group) => group.id)).toEqual(['github-group']);
    expect(service.planOperationCount()).toBe(1);
    expect(service.operations().map((operation) => operation.groupId)).toEqual(['github-group']);
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

  it('restores cached tab analysis as completed scan state', async () => {
    const result = scanResult();
    const service = new WorkflowService(
      {
        session: signal({ token: 'test-session' }),
        loadAnalysis: vi.fn(async () => result),
        loadScan: vi.fn()
      } as never,
      { navigateByUrl: vi.fn() } as never
    );

    await service.restoreCachedState();

    expect(service.scanResult()).toEqual(result);
    expect(service.scanSnapshot()?.scanId).toBe(result.scanId);
    expect(service.scanProgress()?.phase).toBe('completed');
    expect(service.scanDone()).toBe(true);
    expect(service.authState()).toBe('authorized');
  });

  it('restores global cached scan when the current tab has no analysis', async () => {
    const scan = scanSnapshot();
    const loadScan = vi.fn(async () => scan);
    const service = new WorkflowService(
      {
        session: signal({ token: 'test-session' }),
        loadAnalysis: vi.fn(async () => {
          throw new Error('no analysis');
        }),
        loadScan
      } as never,
      { navigateByUrl: vi.fn() } as never
    );

    await service.restoreCachedState();

    expect(loadScan).toHaveBeenCalledTimes(1);
    expect(service.scanSnapshot()).toEqual(scan);
    expect(service.scanResult()).toBeUndefined();
    expect(service.scanProgress()?.phase).toBe('completed');
    expect(service.scanDone()).toBe(true);
  });

  it('joins an active scan when no cached scan is available yet', async () => {
    const scan = scanSnapshot();
    const activeProgress = scanProgress(scan.scanId);
    const streamScanEvents = vi.fn(async (_scanId, _eventsToken, onEvent: (event: unknown) => void) => {
      onEvent({
        type: 'completed',
        progress: {
          ...activeProgress,
          phase: 'completed',
          totalVaults: scan.vaults.length,
          scannedVaults: scan.vaults.length,
          totalItems: scan.items.length,
          scannedItems: scan.items.length
        },
        scan
      });
    });
    const service = new WorkflowService(
      {
        session: signal({ token: 'test-session' }),
        loadAnalysis: vi.fn(async () => {
          throw new Error('no analysis');
        }),
        loadScan: vi.fn(async () => {
          throw new Error('no scan');
        }),
        loadActiveScan: vi.fn(async () => ({
          scanId: scan.scanId,
          mode: 'live',
          progress: activeProgress,
          eventsToken: 'events-token',
          eventCount: 3
        })),
        streamScanEvents
      } as never,
      { navigateByUrl: vi.fn() } as never
    );

    await service.restoreCachedState();

    expect(streamScanEvents).toHaveBeenCalledWith(
      scan.scanId,
      'events-token',
      expect.any(Function),
      expect.objectContaining({ after: 3 })
    );
    expect(service.scanSnapshot()).toEqual(scan);
    expect(service.scanProgress()?.phase).toBe('completed');
    expect(service.scanDone()).toBe(true);
    expect(service.loading()).toBe(false);
  });

  it('shows verification failure when applying one group', async () => {
    const result = scanResult();
    const execute = vi.fn(async (decision: GroupDecision & { dryRun?: boolean }): Promise<ExecuteResponse> => {
      if (decision.dryRun) {
        return { dryRun: true, dryRunKey: 'dry-run-key' };
      }
      return {
        scanInvalidated: true,
        results: [{ itemId: 'private:github-old', action: 'archive', ok: true }],
        verification: {
          ok: false,
          results: [{
            itemId: 'icloud:github-new',
            vaultId: 'icloud',
            action: 'keep',
            ok: false,
            severity: 'critical',
            message: '执行后校验失败：保留项 GitHub 已不在原保险库的活跃列表中。'
          }]
        }
      };
    });
    const service = createService({ execute, createPlan: planFrom(result) });
    service.scanResult.set(result);
    service.decisions.set({
      'icloud:github-new': { itemId: 'icloud:github-new', keep: true, targetVaultId: 'icloud', deleteMode: 'archive' },
      'private:github-old': { itemId: 'private:github-old', keep: false, targetVaultId: 'private', deleteMode: 'archive' }
    });

    await service.openGroupPlanDialog('github-group');
    await service.confirmGroupPlanDialog();

    expect(service.groupApplyError()).toContain('执行后校验失败');
    expect(service.groupApplyError()).toContain('请重新扫描确认');
    expect(service.groupPlanDialog()).toBeDefined();
  });

  it('stops batch apply and skips pending groups after verification failure', async () => {
    const result = scanResult();
    const execute = vi.fn(async (decision: GroupDecision & { dryRun?: boolean }): Promise<ExecuteResponse> => {
      if (decision.dryRun) {
        return { dryRun: true, dryRunKey: `dry-${decision.groupId}` };
      }
      return {
        scanInvalidated: true,
        results: [{ itemId: decision.items[1].itemId, action: 'archive', ok: true }],
        verification: {
          ok: false,
          results: [{
            itemId: decision.items[0].itemId,
            vaultId: decision.items[0].targetVaultId ?? 'unknown',
            action: 'keep',
            ok: false,
            severity: 'critical',
            message: '执行后校验失败，请重新扫描确认。'
          }]
        }
      };
    });
    const service = createService({ execute });
    service.scanResult.set(result);
    service.decisions.set({
      'icloud:github-new': { itemId: 'icloud:github-new', keep: true, targetVaultId: 'icloud', deleteMode: 'archive' },
      'private:github-old': { itemId: 'private:github-old', keep: false, targetVaultId: 'private', deleteMode: 'archive' },
      'private:apple-new': { itemId: 'private:apple-new', keep: true, targetVaultId: 'private', deleteMode: 'archive' },
      'chrome:apple-old': { itemId: 'chrome:apple-old', keep: false, targetVaultId: 'chrome', deleteMode: 'archive' }
    });

    service.prepareBatchPreview();
    await service.applyPlan();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, expect.objectContaining({ groupId: 'github-group', dryRun: true }));
    expect(execute).toHaveBeenNthCalledWith(2, expect.objectContaining({ groupId: 'github-group', confirmedDryRunKey: 'dry-github-group' }));
    expect(service.operations().filter((operation) => operation.groupId === 'github-group').map((operation) => operation.status)).toEqual(['failed']);
    expect(service.operations().filter((operation) => operation.groupId === 'apple-group').map((operation) => operation.status)).toEqual(['skipped']);
  });
});

function createService(overrides: {
  clearScan?: () => Promise<{ ok: boolean }>;
  navigateByUrl?: (url: string) => Promise<boolean>;
  createPlan?: (decision: GroupDecision) => Promise<ReturnType<typeof createExecutionPlan>>;
  execute?: (decision: GroupDecision & Record<string, unknown>) => Promise<ExecuteResponse>;
} = {}): WorkflowService {
  return new WorkflowService(
    {
      session: signal({ token: 'test-session', enableMutations: true }),
      clearScan: overrides.clearScan ?? vi.fn(async () => ({ ok: true })),
      createPlan: overrides.createPlan ?? vi.fn(async (decision: GroupDecision) => createExecutionPlan(decision.groupId, decision, scanResult().items)),
      execute: overrides.execute ?? vi.fn()
    } as never,
    { navigateByUrl: overrides.navigateByUrl ?? vi.fn() } as never
  );
}

function planFrom(result: ScanResult): (decision: GroupDecision) => Promise<ReturnType<typeof createExecutionPlan>> {
  return async (decision) => createExecutionPlan(decision.groupId, decision, result.items);
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
