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
});

function sessionResponse(overrides: Partial<SessionResponse>): SessionResponse {
  return {
    token: 'token',
    mode: 'browser-dev',
    apiBaseUrl: 'http://127.0.0.1:3417',
    enableMutations: false,
    forceDryRun: true,
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
