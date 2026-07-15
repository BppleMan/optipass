import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { invoke } from '@tauri-apps/api/core';
import { vi } from 'vitest';
import { ApiService, SessionResponse } from './api.service';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

describe('ApiService session bootstrap', () => {
  let service: ApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.mocked(invoke).mockReset();

    TestBed.configureTestingModule({
      providers: [
        ApiService,
        provideHttpClient(),
        provideHttpClientTesting()
      ]
    });
    service = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.unstubAllGlobals();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    TestBed.resetTestingModule();
  });

  it('loads browser sessions from the relative API endpoint', async () => {
    const loading = service.loadSession();
    await Promise.resolve();
    const request = http.expectOne('/api/session');

    expect(request.request.headers.has('x-session-token')).toBe(false);
    request.flush(sessionResponse({ token: 'browser-token', mode: 'browser-dev' }));

    await expect(loading).resolves.toMatchObject({
      token: 'browser-token',
      mode: 'browser-dev'
    });
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it('loads Tauri backend sessions through Rust IPC before using HTTP', async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue({
      baseUrl: 'http://127.0.0.1:49152/',
      token: 'tauri-token'
    });

    const loading = service.loadSession();
    await vi.waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('backend_session');
    });
    await Promise.resolve();
    const request = http.expectOne('http://127.0.0.1:49152/api/session');

    expect(request.request.headers.get('x-session-token')).toBe('tauri-token');
    request.flush(sessionResponse({ token: 'tauri-token', mode: 'tauri' }));

    await expect(loading).resolves.toMatchObject({
      token: 'tauri-token',
      mode: 'tauri'
    });
  });

  it('updates mutation mode through the session API', async () => {
    service.session.set(sessionResponse({ token: 'browser-token', enableMutations: false }));

    const updating = service.setMutationsEnabled(true);
    const request = http.expectOne('/api/session/mutations');

    expect(request.request.method).toBe('PATCH');
    expect(request.request.headers.get('x-session-token')).toBe('browser-token');
    expect(request.request.body).toEqual({ enableMutations: true });
    request.flush(sessionResponse({ token: 'browser-token', enableMutations: true }));

    await expect(updating).resolves.toMatchObject({ enableMutations: true });
    expect(service.session()?.enableMutations).toBe(true);
  });

  it("sends the selected dry-run speed with a batch execution", async () => {
    service.session.set(sessionResponse({ token: "browser-token" }));
    const draft = {
      scanId: "scan-test",
      groups: [{
        groupId: "group-test",
        items: [{ itemId: "vault:item", keep: false, deleteMode: "archive" as const }],
      }],
    };

    const starting = service.startActionExecution(draft, undefined, 5);
    const request = http.expectOne("/api/action-executions/start");

    expect(request.request.body).toEqual({
      draft,
      permanentDeleteConfirmationPhrase: undefined,
      dryRunSpeedMultiplier: 5,
    });
    request.flush({
      executionId: "execution-test",
      eventsToken: "events-token",
      status: "running",
      writeEnabled: false,
      dryRunSpeedMultiplier: 5,
      totalGroups: 1,
      totalOperations: 1,
      completedOperations: 0,
      cancelledOperations: 0,
      plan: {},
      draft,
    });

    await expect(starting).resolves.toMatchObject({ dryRunSpeedMultiplier: 5 });
  });

  it('streams scan events through native EventSource and closes after a terminal event', async () => {
    const completed = scanEvent('completed', 'completed', 2);
    const onEvent = vi.fn();
    class MockEventSource {
      static readonly instances: MockEventSource[] = [];
      readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
      readonly close = vi.fn();
      onerror: (() => void) | null = null;
      readyState = 1;

      constructor(readonly url: string) {
        MockEventSource.instances.push(this);
      }

      addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      emit(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(new MessageEvent(type, { data: JSON.stringify(event) }));
        }
      }
    }
    vi.stubGlobal('EventSource', MockEventSource);

    const streaming = service.streamScanEvents('scan-test', 'events-token', onEvent);
    const source = MockEventSource.instances[0];
    source.emit('completed', completed);

    await streaming;

    expect(source.url).toBe('/api/scan/events?scanId=scan-test&eventsToken=events-token');
    expect(onEvent).toHaveBeenCalledWith(completed);
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('falls back to fetch streaming when EventSource is unavailable', async () => {
    const completed = scanEvent('completed', 'completed', 2);
    const read = vi.fn()
      .mockResolvedValueOnce({
        value: new TextEncoder().encode(`event: completed\ndata: ${JSON.stringify(completed)}\n\n`),
        done: false
      })
      .mockRejectedValueOnce(new Error('Load failed'));
    const onEvent = vi.fn();

    vi.stubGlobal('EventSource', undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: {
        getReader: () => ({ read })
      }
    })));

    await service.streamScanEvents('scan-test', 'events-token', onEvent);

    expect(onEvent).toHaveBeenCalledWith(completed);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('closes the action execution stream when an event consumer fails', async () => {
    class MockEventSource {
      static readonly instances: MockEventSource[] = [];
      readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
      readonly close = vi.fn();
      onerror: (() => void) | null = null;
      readyState = 1;

      constructor(readonly url: string) {
        MockEventSource.instances.push(this);
      }

      addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      emit(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(new MessageEvent(type, { data: JSON.stringify(event) }));
        }
      }
    }
    vi.stubGlobal('EventSource', MockEventSource);
    const streaming = service.streamActionExecutionEvents('execution-test', 'events-token', () => {
      throw new Error('consumer failed');
    });
    const rejected = expect(streaming).rejects.toThrow('consumer failed');

    MockEventSource.instances[0].emit('refreshed', { type: 'refreshed' });

    await rejected;
    expect(MockEventSource.instances[0].close).toHaveBeenCalledTimes(1);
  });
});

function sessionResponse(overrides: Partial<SessionResponse>): SessionResponse {
  return {
    token: 'token',
    mode: 'browser-dev',
    apiBaseUrl: 'http://127.0.0.1:3417',
    enableMutations: false,
    hasServiceAccountToken: false,
    supportsDesktopAuth: true,
    idleShutdownMs: null,
    capabilities: {
      staticUi: false,
      canShutdown: false,
      supportsHeartbeat: false,
      supportsIdleShutdown: false,
      supportsDesktopAuth: true,
      shell: 'browser'
    },
    ...overrides
  };
}

function scanEvent(type: 'progress' | 'completed', phase: 'scanning' | 'completed', scannedItems: number) {
  return {
    type,
    progress: {
      scanId: 'scan-test',
      phase,
      totalVaults: 1,
      scannedVaults: phase === 'completed' ? 1 : 0,
      totalItems: 2,
      scannedItems,
      vaults: [],
      message: phase === 'completed' ? '扫描完成，等待手动分析。' : '正在读取项目详情。'
    }
  };
}
