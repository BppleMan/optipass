import { signal } from '@angular/core';
import { vi } from 'vitest';
import { createExecutionPlan, type ActionDraft, type DuplicateGroup, type GroupDecision, type ItemSummary, type ScanProgress, type ScanResult, type ScanSnapshot } from '@optimize-password/core';
import type { ExecuteResponse, SkipGroupResponse } from '../../../core/services/api.service';
import { WorkflowService } from './workflow.service';

describe('WorkflowService analysis filters', () => {
  it('keeps multiple credential metadata fields as separate detail entries', () => {
    const service = createService();
    const result = scanResult();
    result.items[0].comparableFields = [
      { label: '主密码', kind: 'secret' },
      { label: '恢复密钥', kind: 'secret' }
    ];
    service.scanResult.set(result);

    expect(service.visibleGroups()[0].items[0].credChips.map((chip) => ({ label: chip.label, kind: chip.kind }))).toEqual([
      { label: '主密码', kind: 'password' },
      { label: '恢复密钥', kind: 'secret' }
    ]);
  });

  it('keeps tag removal as a reversible draft and includes it in the plan', () => {
    const service = createService();
    const result = scanResult();
    result.items[0].tags = ['CSV Import', 'work'];
    service.scanResult.set(result);
    service.decisions.set({
      'icloud:github-new': { itemId: 'icloud:github-new', keep: true, targetVaultId: 'icloud', removeTags: [] },
      'private:github-old': { itemId: 'private:github-old', keep: false, targetVaultId: 'private', deleteMode: 'archive' }
    });

    service.toggleTagRemoval('icloud:github-new', 'CSV Import');

    const itemView = service.visibleGroups()[0].items[0];
    const plan = service.allPreviewGroups()[0].plan!;
    expect(itemView.removedTags).toEqual(['CSV Import']);
    expect(itemView.remainingTagCount).toBe(1);
    expect(plan.actions).toContainEqual({
      type: 'update-tags',
      itemId: 'icloud:github-new',
      vaultId: 'icloud',
      removeTags: ['CSV Import']
    });

    service.toggleTagRemoval('icloud:github-new', 'CSV Import');
    expect(service.visibleGroups()[0].items[0].removedTags).toEqual([]);
  });

  it('applies a shared tag removal only to kept items in the group', () => {
    const service = createService();
    const result = scanResult();
    result.items[0].tags = ['CSV Import'];
    result.items[1].tags = ['CSV Import'];
    service.scanResult.set(result);
    service.decisions.set({
      'icloud:github-new': { itemId: 'icloud:github-new', keep: true, targetVaultId: 'icloud' },
      'private:github-old': { itemId: 'private:github-old', keep: false, targetVaultId: 'private', deleteMode: 'archive' }
    });

    service.removeTagFromGroup('github-group', 'CSV Import');

    expect(service.decisions()['icloud:github-new'].removeTags).toEqual(['CSV Import']);
    expect(service.decisions()['private:github-old'].removeTags).toBeUndefined();
  });

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

  it('filters complete groups by item ids returned from global search', async () => {
    const suggestion = {
      id: 'field:title:private:github-old',
      kind: 'field' as const,
      label: 'GitHub old',
      field: 'title' as const,
      itemIds: ['private:github-old'],
      count: 1
    };
    const searchItems = vi.fn(async () => ({ itemIds: ['private:github-old'], suggestions: [suggestion] }));
    const service = createService({ searchItems });
    service.scanResult.set(scanResult());

    await service.updateGlobalSearchQuery('github 2025');

    expect(searchItems).toHaveBeenCalledWith(['github', '2025']);
    expect(service.visibleGroups().map((group) => group.id)).toEqual(['github-group']);
    expect(service.analysisFilterSummary().chips.map((chip) => chip.label)).toEqual(['搜索：github 2025']);
    expect(service.globalSearchSuggestionGroups()).toEqual([{
      kind: 'field',
      label: '字段匹配项',
      allSelected: false,
      someSelected: false,
      suggestions: [{ ...suggestion, index: 0, selected: false, detail: '标题匹配' }]
    }]);

    service.selectGlobalSearchSuggestion(suggestion);
    expect(service.globalSearchAutocompleteOpen()).toBe(true);
    expect(service.selectedGlobalSearchSuggestionCount()).toBe(1);
    expect(service.analysisFilterSummary().chips.map((chip) => chip.label)).toEqual(['字段匹配项：GitHub old']);

    service.toggleAnalysisFilter('vaults', 'private', true);
    expect(service.visibleGroups().map((group) => group.id)).toEqual(['github-group']);

    service.removeAnalysisFilter('search', 'github 2025');
    expect(service.globalSearchQuery()).toBe('');
    expect(service.visibleGroups().map((group) => group.id)).toEqual(['github-group', 'apple-group']);
  });

  it('supports single, multiple, group, and global autocomplete selection', async () => {
    const githubSuggestion = {
      id: 'domain:github.com',
      kind: 'domain' as const,
      label: 'github.com',
      itemIds: ['private:github-old'],
      count: 1
    };
    const appleSuggestion = {
      id: 'domain:apple.com',
      kind: 'domain' as const,
      label: 'apple.com',
      itemIds: ['private:apple-new'],
      count: 1
    };
    const titleSuggestion = {
      id: 'field:title:icloud:github-new',
      kind: 'field' as const,
      label: 'GitHub',
      field: 'title' as const,
      itemIds: ['icloud:github-new'],
      count: 1
    };
    const suggestions = [githubSuggestion, appleSuggestion, titleSuggestion];
    const service = createService({
      searchItems: vi.fn(async () => ({
        itemIds: ['private:github-old', 'private:apple-new', 'icloud:github-new'],
        suggestions
      }))
    });
    service.scanResult.set(scanResult());

    await service.updateGlobalSearchQuery('com');
    service.selectGlobalSearchSuggestion(githubSuggestion);
    expect(service.visibleGroups().map((group) => group.id)).toEqual(['github-group']);

    service.selectGlobalSearchSuggestion(appleSuggestion);
    expect(service.visibleGroups().map((group) => group.id)).toEqual(['github-group', 'apple-group']);
    expect(service.analysisFilterSummary().chips.map((chip) => chip.label)).toEqual(['已选 2 个补全项']);

    const domainGroup = service.globalSearchSuggestionGroups().find((group) => group.kind === 'domain')!;
    expect(domainGroup.allSelected).toBe(true);
    service.toggleGlobalSearchSuggestionGroup(domainGroup);
    expect(service.selectedGlobalSearchSuggestionCount()).toBe(0);
    expect(service.visibleGroups().map((group) => group.id)).toEqual(['github-group', 'apple-group']);

    service.toggleAllGlobalSearchSuggestions();
    expect(service.selectedGlobalSearchSuggestionCount()).toBe(3);
    expect(service.allGlobalSearchSuggestionsSelected()).toBe(true);
    service.toggleAllGlobalSearchSuggestions();
    expect(service.selectedGlobalSearchSuggestionCount()).toBe(0);
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

  it('limits batch apply operations to currently filtered groups', async () => {
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
    await service.applyPlan();

    expect(service.visiblePreviewGroups().map((group) => group.id)).toEqual(['github-group']);
    expect(service.planOperationCount()).toBe(1);
    expect(service.operations().map((operation) => operation.groupId)).toEqual(['github-group']);
    expect(service.operationGroups()).toHaveLength(1);
    expect(service.operationGroups()[0]).toMatchObject({
      id: 'github-group',
      total: 1,
      completed: 1,
      status: 'done'
    });
  });

  it('keeps skipped groups as reversible no-op preview entries', async () => {
    const service = createService();
    service.scanResult.set(scanResult());
    service.decisions.set({
      'icloud:github-new': { itemId: 'icloud:github-new', keep: true, targetVaultId: 'icloud', deleteMode: 'archive' },
      'private:github-old': { itemId: 'private:github-old', keep: false, targetVaultId: 'private', deleteMode: 'archive' },
      'private:apple-new': { itemId: 'private:apple-new', keep: true, targetVaultId: 'private', deleteMode: 'archive' },
      'chrome:apple-old': { itemId: 'chrome:apple-old', keep: false, targetVaultId: 'chrome', deleteMode: 'archive' }
    });

    await service.toggleGroupSkip('github-group');

    const skippedGroup = service.visiblePreviewGroups().find((group) => group.id === 'github-group');
    expect(service.visibleGroups().find((group) => group.id === 'github-group')?.skipped).toBe(true);
    expect(skippedGroup?.plan).toBeUndefined();
    expect(skippedGroup?.actions.map((action) => action.tone)).toEqual(['skip']);
    expect(service.decisionStats().groups).toBe(1);
    expect(service.decisionStats().skipped).toBe(1);

    await service.toggleGroupSkip('github-group');

    expect(service.visibleGroups().find((group) => group.id === 'github-group')?.skipped).toBe(false);
    expect(service.visiblePreviewGroups().find((group) => group.id === 'github-group')?.actions.some((action) => action.tone === 'skip')).toBe(false);
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
        session: signal({ token: 'test-session', resumeAccountName: 'BppleMan' }),
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
    expect(service.account()).toBe('BppleMan');
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

  it('updates the current action and grouped progress from SSE events', async () => {
    let service!: WorkflowService;
    const result = { itemId: 'private:github-old', action: 'archive', ok: true, dryRun: true };
    const streamActionExecutionEvents = vi.fn(async (_executionId: string, _eventsToken: string, onEvent: (event: never) => void) => {
      onEvent({
        type: 'action-started',
        sequence: 1,
        executionId: 'action-execution-test',
        status: 'running',
        writeEnabled: false,
        totalGroups: 1,
        totalOperations: 1,
        completedOperations: 0,
        groupId: 'github-group',
        action: { itemId: result.itemId, type: result.action }
      } as never);
      expect(service.operations().map((operation) => operation.status)).toEqual(['running']);
      expect(service.operationGroups()[0]).toMatchObject({ status: 'running', completed: 0, total: 1 });

      onEvent({
        type: 'action-completed',
        sequence: 2,
        executionId: 'action-execution-test',
        status: 'running',
        writeEnabled: false,
        totalGroups: 1,
        totalOperations: 1,
        completedOperations: 1,
        groupId: 'github-group',
        result
      } as never);
      expect(service.operations().map((operation) => operation.status)).toEqual(['done']);

      onEvent({
        type: 'completed',
        sequence: 3,
        executionId: 'action-execution-test',
        status: 'completed',
        writeEnabled: false,
        totalGroups: 1,
        totalOperations: 1,
        completedOperations: 1,
      } as never);
    });
    service = createService({ streamActionExecutionEvents, enableMutations: false });
    service.scanResult.set(scanResult());
    service.decisions.set({
      'icloud:github-new': { itemId: 'icloud:github-new', keep: true, targetVaultId: 'icloud', deleteMode: 'archive' },
      'private:github-old': { itemId: 'private:github-old', keep: false, targetVaultId: 'private', deleteMode: 'archive' },
      'private:apple-new': { itemId: 'private:apple-new', keep: true, targetVaultId: 'private', deleteMode: 'archive' },
      'chrome:apple-old': { itemId: 'chrome:apple-old', keep: false, targetVaultId: 'chrome', deleteMode: 'archive' }
    });
    service.toggleAnalysisFilter('vaults', 'icloud', true);

    await service.applyPlan();

    expect(streamActionExecutionEvents).toHaveBeenCalledTimes(1);
    expect(service.applyDialogOpen()).toBe(true);
    expect(service.operationGroups()[0].operations[0].label).toContain('归档「GitHub old」');
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

    await service.applyPlan();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'github-group' }));
    expect(service.operations().filter((operation) => operation.groupId === 'github-group').map((operation) => operation.status)).toEqual(['done']);
    expect(service.operationGroups().find((group) => group.id === 'github-group')).toMatchObject({ status: 'failed', statusText: '校验失败' });
    expect(service.operations().filter((operation) => operation.groupId === 'apple-group').map((operation) => operation.status)).toEqual(['skipped']);
  });

  it('keeps apply enabled in dry-run mode and does not submit a write execution', async () => {
    const result = scanResult();
    const execute = vi.fn(async (decision: GroupDecision & { dryRun?: boolean }): Promise<ExecuteResponse> => ({
      dryRun: true,
      dryRunKey: `dry-${decision.groupId}`,
      results: decision.items.filter((item) => !item.keep).map((item) => ({
        itemId: item.itemId,
        action: item.deleteMode === 'delete' ? 'delete' : 'archive',
        ok: true,
        dryRun: true,
      })),
    }));
    const service = createService({ execute, enableMutations: false });
    service.scanResult.set(result);
    service.decisions.set({
      'icloud:github-new': { itemId: 'icloud:github-new', keep: true, targetVaultId: 'icloud', deleteMode: 'archive' },
      'private:github-old': { itemId: 'private:github-old', keep: false, targetVaultId: 'private', deleteMode: 'archive' }
    });

    expect(service.canApply()).toBe(true);
    expect(service.applyDialogOpen()).toBe(false);

    await service.applyPlan();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(service.operations().every((operation) => operation.status === 'done' && operation.dryRun)).toBe(true);
    expect(service.applyDialogOpen()).toBe(true);
    expect(service.status()).toContain('试写完成');

    service.closeApplyDialog();

    expect(service.applyDialogOpen()).toBe(false);
  });
});

function createService(overrides: {
  clearScan?: () => Promise<{ ok: boolean }>;
  navigateByUrl?: (url: string) => Promise<boolean>;
  createPlan?: (decision: GroupDecision) => Promise<ReturnType<typeof createExecutionPlan>>;
  execute?: (decision: GroupDecision) => Promise<ExecuteResponse>;
  skipGroup?: (scanId: string, groupId: string) => Promise<SkipGroupResponse>;
  restoreSkippedGroup?: (scanId: string, groupId: string) => Promise<SkipGroupResponse>;
  searchItems?: (keywords: string[]) => Promise<{ itemIds: string[]; suggestions: Array<{
    id: string;
    kind: 'year' | 'vault' | 'credential' | 'domain' | 'field';
    label: string;
    field?: 'title' | 'username' | 'url' | 'phone' | 'email' | 'note';
    itemIds: string[];
    count: number;
  }> }>;
  streamActionExecutionEvents?: (
    executionId: string,
    eventsToken: string,
    onEvent: (event: never) => void
  ) => Promise<void>;
  streamExecutionEvents?: (
    executionId: string,
    eventsToken: string,
    onEvent: (event: never) => void
  ) => Promise<void>;
  enableMutations?: boolean;
} = {}): WorkflowService {
  const execute = overrides.execute ?? vi.fn(async (): Promise<ExecuteResponse> => ({
    dryRun: true,
    results: []
  }));
  let pendingDecision: GroupDecision | undefined;
  let pendingDraft: ActionDraft | undefined;
  return new WorkflowService(
    {
      session: signal({ token: 'test-session', enableMutations: overrides.enableMutations ?? true }),
      clearScan: overrides.clearScan ?? vi.fn(async () => ({ ok: true })),
      createPlan: overrides.createPlan ?? vi.fn(async (decision: GroupDecision) => createExecutionPlan(decision.groupId, decision, scanResult().items)),
      execute,
      startExecution: vi.fn(async (decision: GroupDecision) => {
        pendingDecision = decision;
        return {
          executionId: 'execution-test',
          eventsToken: 'events-token',
          dryRun: !Boolean(overrides.enableMutations ?? true),
          totalOperations: decision.items.filter((item) => !item.keep).length
        };
      }),
      startActionExecution: vi.fn(async (draft: ActionDraft) => {
        pendingDraft = draft;
        return {
          executionId: 'action-execution-test',
          eventsToken: 'action-events-token',
          status: 'running',
          writeEnabled: Boolean(overrides.enableMutations ?? true),
          totalGroups: draft.groups.length,
          totalOperations: draft.groups.flatMap((group) => group.items).filter((item) => !item.keep).length,
          completedOperations: 0,
          cancelledOperations: 0,
          plan: {} as never,
          draft,
        };
      }),
      pauseActionExecution: vi.fn(),
      resumeActionExecution: vi.fn(),
      stopActionExecution: vi.fn(),
      streamActionExecutionEvents: overrides.streamActionExecutionEvents ?? vi.fn(async (_executionId: string, _eventsToken: string, onEvent: (event: never) => void) => {
        let sequence = 0;
        let completedOperations = 0;
        for (const decision of pendingDraft!.groups) {
          const legacyDecision = { ...decision, scanId: pendingDraft!.scanId };
          const response = await execute(legacyDecision);
          const responseResults = response.results?.length
            ? response.results
            : legacyDecision.items.filter((item) => !item.keep).map((item) => ({
                itemId: item.itemId,
                action: item.deleteMode === 'delete' ? 'delete' : 'archive',
                ok: true,
                dryRun: !Boolean(overrides.enableMutations ?? true),
              }));
          for (const result of responseResults) {
            onEvent({
              type: 'action-started',
              sequence: ++sequence,
              executionId: 'action-execution-test',
              status: 'running',
              writeEnabled: Boolean(overrides.enableMutations ?? true),
              totalGroups: pendingDraft!.groups.length,
              totalOperations: pendingDraft!.groups.flatMap((group) => group.items).filter((item) => !item.keep).length,
              completedOperations,
              groupId: legacyDecision.groupId,
              action: { itemId: result.itemId, type: result.action },
            } as never);
            completedOperations += 1;
            onEvent({
              type: result.ok ? 'action-completed' : 'action-failed',
              sequence: ++sequence,
              executionId: 'action-execution-test',
              status: 'running',
              writeEnabled: Boolean(overrides.enableMutations ?? true),
              totalGroups: pendingDraft!.groups.length,
              totalOperations: pendingDraft!.groups.flatMap((group) => group.items).filter((item) => !item.keep).length,
              completedOperations,
              groupId: legacyDecision.groupId,
              result,
            } as never);
          }
          if (response.scanInvalidated) {
            onEvent({
              type: 'failed',
              sequence: ++sequence,
              executionId: 'action-execution-test',
              status: 'failed',
              writeEnabled: Boolean(overrides.enableMutations ?? true),
              totalGroups: pendingDraft!.groups.length,
              totalOperations: pendingDraft!.groups.flatMap((group) => group.items).filter((item) => !item.keep).length,
              completedOperations,
              groupId: legacyDecision.groupId,
              error: response.verification?.results.find((result) => !result.ok)?.message ?? '执行失败。',
            } as never);
            break;
          }
        }
        onEvent({
          type: 'completed',
          sequence: ++sequence,
          executionId: 'action-execution-test',
          status: 'completed',
          writeEnabled: Boolean(overrides.enableMutations ?? true),
          totalGroups: pendingDraft!.groups.length,
          totalOperations: pendingDraft!.groups.flatMap((group) => group.items).filter((item) => !item.keep).length,
          completedOperations,
        } as never);
      }),
      streamExecutionEvents: overrides.streamExecutionEvents ?? vi.fn(async (_executionId: string, _eventsToken: string, onEvent: (event: never) => void) => {
        const response = await execute(pendingDecision!);
        for (const result of response.results ?? []) {
          onEvent({
            type: 'action-started',
            sequence: 1,
            executionId: 'execution-test',
            dryRun: Boolean(response.dryRun),
            totalOperations: pendingDecision!.items.filter((item) => !item.keep).length,
            completedOperations: 0,
            action: { itemId: result.itemId, type: result.action }
          } as never);
          onEvent({
            type: 'action',
            sequence: 2,
            executionId: 'execution-test',
            dryRun: Boolean(response.dryRun),
            totalOperations: pendingDecision!.items.filter((item) => !item.keep).length,
            completedOperations: 1,
            result
          } as never);
        }
        onEvent({
          type: 'completed',
          sequence: 3,
          executionId: 'execution-test',
          dryRun: Boolean(response.dryRun),
          totalOperations: pendingDecision!.items.filter((item) => !item.keep).length,
          completedOperations: pendingDecision!.items.filter((item) => !item.keep).length,
          response
        } as never);
      }),
      skipGroup: overrides.skipGroup ?? vi.fn(async (_scanId: string, groupId: string) => ({
        skippedGroupId: groupId,
        restorableSkippedGroupCount: 1,
        scan: { ...scanResult(), skippedGroupIds: [groupId] }
      })),
      restoreSkippedGroup: overrides.restoreSkippedGroup ?? vi.fn(async (scanId: string, groupId: string) => ({
        skippedGroupId: groupId,
        restorableSkippedGroupCount: 0,
        scan: { ...scanResult(), scanId, skippedGroupIds: [] }
      })),
      searchItems: overrides.searchItems ?? vi.fn(async () => ({ itemIds: [], suggestions: [] }))
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
