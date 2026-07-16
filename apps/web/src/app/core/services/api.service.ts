import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { computed, Injectable, signal } from '@angular/core';
import {
  ActionExecutionStatus,
  ActionExecutionEventKind,
  DryRunSpeedMultiplier,
  type ActionDraft,
  type ActionPlanDto,
  ScanMode,
  type ItemProvider,
  RevealCredentialsResponse,
  ScanProgress,
  ScanProgressEvent,
  ScanResult,
  ScanSnapshot
} from '@optimize-password/core';
import { firstValueFrom } from 'rxjs';

const actionExecutionEventTypes = [
  ActionExecutionEventKind.Started,
  ActionExecutionEventKind.StepStarted,
  ActionExecutionEventKind.StepCompleted,
  ActionExecutionEventKind.StepFailed,
  ActionExecutionEventKind.Paused,
  ActionExecutionEventKind.Resumed,
  ActionExecutionEventKind.StopRequested,
  ActionExecutionEventKind.AnalysisUpdated,
  ActionExecutionEventKind.Stopped,
  ActionExecutionEventKind.Completed,
  ActionExecutionEventKind.Failed,
];

export { DryRunSpeedMultiplier } from '@optimize-password/core';

interface TauriBackendSession {
  baseUrl: string;
  token: string;
}

interface TauriBackendSessionLookup {
  session?: TauriBackendSession;
}

interface ApiSessionState {
  session?: SessionResponse;
  bootstrapToken?: string;
}

export enum ClientAppMode {
  BrowserDev = 'browser-dev', BrowserServe = 'browser-serve', Tauri = 'tauri',
}

export enum ClientShell {
  Browser = 'browser', Tauri = 'tauri',
}

enum ActionExecutionCommand {
  Pause = 'pause', Resume = 'resume', Stop = 'stop',
}

export interface SessionResponse {
  token: string;
  mode: ClientAppMode;
  accountName?: string;
  resumeAccountName?: string;
  apiBaseUrl: string;
  enableMutations: boolean;
  hasServiceAccountToken: boolean;
  supportsDesktopAuth: boolean;
  idleShutdownMs: number;
  capabilities: {
    staticUi: boolean;
    canShutdown: boolean;
    supportsHeartbeat: boolean;
    supportsIdleShutdown: boolean;
    supportsDesktopAuth: boolean;
    shell: ClientShell;
  };
}

export interface ScanStartResponse {
  scanId: string;
  mode: ScanMode;
  progress: ScanProgress;
  eventsToken: string;
}

export interface ActiveScanResponse extends ScanStartResponse {
  eventCount: number;
}

export interface ActionExecutionSnapshot {
  executionId: string;
  eventsToken?: string;
  status: ActionExecutionStatus;
  writeEnabled: boolean;
  dryRunSpeedMultiplier: DryRunSpeedMultiplier;
  totalGroups: number;
  totalOperations: number;
  completedOperations: number;
  cancelledOperations: number;
  plan: ActionPlanDto;
  draft: ActionDraft;
}

export interface ActionExecutionUpdateResponse {
  analysis: AnalysisResultResponse;
  storeVersion: number;
  itemIdMappings: Record<string, string>;
  dryRun: boolean;
}

export interface ActionExecutionEvent {
  type: ActionExecutionEventKind;
  sequence: number;
  executionId: string;
  status: ActionExecutionStatus;
  writeEnabled: boolean;
  totalGroups: number;
  totalOperations: number;
  completedOperations: number;
  groupId?: string;
  actionId?: string;
  stepStatus?: import("@optimize-password/core").ActionStepStatus;
  message?: string;
  response?: ActionExecutionUpdateResponse;
  error?: string;
}

export interface AnalysisResultResponse extends ScanResult {
  skippedGroupIds: string[];
}

export interface ItemSearchResponse {
  itemIds: string[];
}

export interface SkipGroupResponse {
  skippedGroupId: string;
  restorableSkippedGroupCount: number;
  scan: AnalysisResultResponse;
}

const tabIdStorageKey = 'optipass.tabId';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly sessionState = signal<ApiSessionState>({});
  readonly session = computed(() => this.sessionState().session);
  private apiBaseUrl = '';
  private readonly tabId = loadTabId();

  constructor(private readonly http: HttpClient) {}

  public setSession(session: SessionResponse): void {
    this.sessionState.set({ session });
  }

  async loadSession(): Promise<SessionResponse> {
    const tauriSession = await this.loadTauriBackendSession();
    if (tauriSession.session) {
      this.apiBaseUrl = normalizeBaseUrl(tauriSession.session.baseUrl);
      this.sessionState.set({ bootstrapToken: tauriSession.session.token });
    } else {
      this.apiBaseUrl = '';
      this.sessionState.set({});
    }

    const session = await this.request(firstValueFrom(
      this.http.get<SessionResponse>(this.apiUrl('/api/session'), { headers: this.headers() })
    ));
    this.setSession(session);
    return session;
  }

  async startScan(options: { accountName?: string; mode?: ScanMode; provider?: ItemProvider; fileName?: string; csvContent?: string }): Promise<ScanStartResponse> {
    return this.request(firstValueFrom(
      this.http.post<ScanStartResponse>(
        this.apiUrl('/api/scan'),
        {
          accountName: options.accountName || undefined,
          mode: options.mode ?? ScanMode.Live,
          provider: options.provider,
          fileName: options.fileName,
          csvContent: options.csvContent,
        },
        { headers: this.headers() }
      )
    ));
  }

  async loadScan(): Promise<ScanSnapshot> {
    return this.request(firstValueFrom(this.http.get<ScanSnapshot>(this.apiUrl('/api/scan'), { headers: this.headers() })));
  }

  async loadActiveScan(): Promise<ActiveScanResponse> {
    return this.request(firstValueFrom(this.http.get<ActiveScanResponse>(this.apiUrl('/api/scan/active'), { headers: this.headers() })));
  }

  async loadAnalysis(): Promise<AnalysisResultResponse> {
    return this.request(firstValueFrom(this.http.get<AnalysisResultResponse>(this.apiUrl('/api/analysis'), { headers: this.headers() })));
  }

  async analyze(scanId: string): Promise<AnalysisResultResponse> {
    return this.request(firstValueFrom(
      this.http.post<AnalysisResultResponse>(this.apiUrl('/api/analyze'), { scanId }, { headers: this.headers() })
    ));
  }

  async searchItems(keywords: string[], itemIds: string[]): Promise<ItemSearchResponse> {
    return this.request(firstValueFrom(
      this.http.post<ItemSearchResponse>(this.apiUrl("/api/items/search"), { keywords, itemIds }, { headers: this.headers() })
    ));
  }

  async revealCredentials(scanId: string, itemId: string): Promise<RevealCredentialsResponse> {
    return this.request(firstValueFrom(
      this.http.post<RevealCredentialsResponse>(
        this.apiUrl(`/api/items/${encodeURIComponent(itemId)}/reveal`),
        { scanId },
        { headers: this.headers() }
      )
    ));
  }

  async streamScanEvents(
    scanId: string,
    eventsToken: string,
    onEvent: (event: ScanProgressEvent) => void,
    options: { signal?: AbortSignal; after?: number } = {}
  ): Promise<void> {
    if (typeof EventSource !== 'undefined') {
      await this.streamScanEventsWithEventSource(scanId, eventsToken, onEvent, options);
      return;
    }

    await this.streamScanEventsWithFetch(scanId, eventsToken, onEvent, options);
  }

  private streamScanEventsWithEventSource(
    scanId: string,
    eventsToken: string,
    onEvent: (event: ScanProgressEvent) => void,
    options: { signal?: AbortSignal; after?: number } = {}
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        resolve();
        return;
      }

      const source = new EventSource(this.scanEventsUrl(scanId, eventsToken, options.after));
      let settled = false;

      function settle(callback: () => void): void {
        if (settled) {
          return;
        }
        settled = true;
        options.signal?.removeEventListener('abort', abort);
        source.close();
        callback();
      }
      function abort(): void {
        settle(resolve);
      }
      function handleEvent(message: Event): void {
        const data = (message as MessageEvent<string>).data;
        const event = JSON.parse(data) as ScanProgressEvent;
        onEvent(event);
        if (event.type === 'completed' || event.type === 'failed') {
          settle(resolve);
        }
      }

      source.addEventListener('started', handleEvent);
      source.addEventListener('progress', handleEvent);
      source.addEventListener('completed', handleEvent);
      source.addEventListener('failed', handleEvent);
      source.onerror = () => {
        if (source.readyState === EventSource.CLOSED) {
          settle(() => reject(new Error('扫描进度流已关闭。')));
        }
      };
      options.signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private async streamScanEventsWithFetch(
    scanId: string,
    eventsToken: string,
    onEvent: (event: ScanProgressEvent) => void,
    options: { signal?: AbortSignal; after?: number } = {}
  ): Promise<void> {
    const response = await fetch(this.scanEventsUrl(scanId, eventsToken, options.after), {
      headers: this.fetchHeaders(),
      cache: 'no-store',
      signal: options.signal
    });
    if (!response.ok) {
      throw new Error(await this.fetchErrorMessage(response));
    }
    if (!response.body) {
      throw new Error('当前浏览器不支持扫描进度流。');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!options.signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          const event = JSON.parse(data) as ScanProgressEvent;
          onEvent(event);
          if (event.type === 'completed' || event.type === 'failed') {
            return;
          }
        }
      }
    }
  }

  async createPlan(draft: ActionDraft): Promise<ActionPlanDto> {
    return this.request(firstValueFrom(this.http.post<ActionPlanDto>(this.apiUrl("/api/plan"), draft, { headers: this.headers() })));
  }

  async skipGroup(scanId: string, groupId: string): Promise<SkipGroupResponse> {
    return this.request(firstValueFrom(
      this.http.post<SkipGroupResponse>(
        this.apiUrl(`/api/groups/${encodeURIComponent(groupId)}/skip`),
        { scanId },
        { headers: this.headers() }
      )
    ));
  }

  async restoreSkippedGroup(scanId: string, groupId: string): Promise<SkipGroupResponse> {
    return this.request(firstValueFrom(
      this.http.post<SkipGroupResponse>(
        this.apiUrl(`/api/groups/${encodeURIComponent(groupId)}/restore`),
        { scanId },
        { headers: this.headers() }
      )
    ));
  }

  async startActionExecution(
    planId: string,
    planHash: string,
    permanentDeleteConfirmationPhrase?: string,
    dryRunSpeedMultiplier: DryRunSpeedMultiplier = DryRunSpeedMultiplier.One,
  ): Promise<ActionExecutionSnapshot> {
    return this.request(firstValueFrom(this.http.post<ActionExecutionSnapshot>(
      this.apiUrl('/api/action-executions/start'),
      { planId, planHash, permanentDeleteConfirmationPhrase, dryRunSpeedMultiplier },
      { headers: this.headers() }
    )));
  }

  async pauseActionExecution(executionId: string): Promise<ActionExecutionSnapshot> {
    return this.actionExecutionCommand(executionId, ActionExecutionCommand.Pause);
  }

  async resumeActionExecution(executionId: string): Promise<ActionExecutionSnapshot> {
    return this.actionExecutionCommand(executionId, ActionExecutionCommand.Resume);
  }

  async stopActionExecution(executionId: string): Promise<ActionExecutionSnapshot> {
    return this.actionExecutionCommand(executionId, ActionExecutionCommand.Stop);
  }

  async streamActionExecutionEvents(
    executionId: string,
    eventsToken: string,
    onEvent: (event: ActionExecutionEvent) => void,
    after = 0
  ): Promise<void> {
    const source = new EventSource(this.actionExecutionEventsUrl(executionId, eventsToken, after));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        source.close();
        callback();
      };
      const handle = (message: Event): void => {
        try {
          const event = JSON.parse((message as MessageEvent<string>).data) as ActionExecutionEvent;
          onEvent(event);
          if (event.type === 'stopped' || event.type === 'completed' || event.type === 'failed') {
            settle(resolve);
          }
        } catch (error) {
          settle(() => reject(error instanceof Error ? error : new Error('无法处理执行进度事件。')));
        }
      };
      for (const type of actionExecutionEventTypes) {
        source.addEventListener(type, handle);
      }
      source.onerror = () => source.readyState === EventSource.CLOSED && settle(() => reject(new Error('执行进度流已关闭。')));
    });
  }

  async setMutationsEnabled(enableMutations: boolean): Promise<SessionResponse> {
    const session = await this.request(firstValueFrom(
      this.http.patch<SessionResponse>(
        this.apiUrl('/api/session/mutations'),
        { enableMutations },
        { headers: this.headers() }
      )
    ));
    this.setSession(session);
    return session;
  }

  async clearScan(): Promise<{ ok: boolean }> {
    return this.request(firstValueFrom(this.http.post<{ ok: boolean }>(this.apiUrl('/api/scan/clear'), {}, { headers: this.headers() })));
  }

  async heartbeat(): Promise<{ ok: boolean; idleShutdownMs: number }> {
    return this.request(firstValueFrom(
      this.http.post<{ ok: boolean; idleShutdownMs: number }>(this.apiUrl('/api/session/heartbeat'), {}, { headers: this.headers() })
    ));
  }

  async shutdown(): Promise<{ ok: boolean }> {
    return this.request(firstValueFrom(this.http.post<{ ok: boolean }>(this.apiUrl('/api/session/shutdown'), {}, { headers: this.headers() })));
  }

  private headers(): HttpHeaders {
    const token = this.session()?.token ?? this.sessionState().bootstrapToken;
    const headers: Record<string, string> = { 'x-tab-id': this.tabId };
    if (token) {
      headers['x-session-token'] = token;
    }
    return new HttpHeaders(headers);
  }

  private fetchHeaders(): HeadersInit {
    const token = this.session()?.token ?? this.sessionState().bootstrapToken;
    return token ? { 'x-session-token': token, 'x-tab-id': this.tabId } : { 'x-tab-id': this.tabId };
  }

  private apiUrl(path: string): string {
    return `${this.apiBaseUrl}${path}`;
  }

  private scanEventsUrl(scanId: string, eventsToken: string, after = 0): string {
    const query = new URLSearchParams({
      scanId,
      eventsToken
    });
    if (after > 0) {
      query.set('after', String(after));
    }
    return this.apiUrl(`/api/scan/events?${query.toString()}`);
  }

  private actionExecutionEventsUrl(executionId: string, eventsToken: string, after = 0): string {
    const query = new URLSearchParams({ eventsToken });
    if (after > 0) {
      query.set('after', String(after));
    }
    return this.apiUrl(`/api/action-executions/${ encodeURIComponent(executionId) }/events?${ query.toString() }`);
  }

  private async actionExecutionCommand(executionId: string, command: ActionExecutionCommand): Promise<ActionExecutionSnapshot> {
    return this.request(firstValueFrom(this.http.post<ActionExecutionSnapshot>(
      this.apiUrl(`/api/action-executions/${ encodeURIComponent(executionId) }/${ command }`),
      {},
      { headers: this.headers() }
    )));
  }

  private async loadTauriBackendSession(): Promise<TauriBackendSessionLookup> {
    if (!isTauriRuntime()) {
      return {};
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return { session: await invoke<TauriBackendSession>('backend_session') };
    } catch (error) {
      throw new Error(`无法启动本地 API：${this.apiErrorMessage(error)}`);
    }
  }

  private async request<T>(request: Promise<T>): Promise<T> {
    try {
      return await request;
    } catch (error) {
      throw new Error(this.apiErrorMessage(error));
    }
  }

  private apiErrorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) {
        return '无法连接本地 API，请确认后端服务正在运行。';
      }
      const body = error.error as unknown;
      if (body && typeof body === 'object' && 'message' in body) {
        return String((body as { message: unknown }).message);
      }
      if (body && typeof body === 'object' && 'error' in body) {
        return String((body as { error: unknown }).error);
      }
      if (typeof body === 'string' && body.trim()) {
        return body;
      }
      return this.httpStatusMessage(error.status);
    }
    if (error instanceof Error) {
      return error.message || '操作失败，请稍后重试。';
    }
    return '操作失败，请稍后重试。';
  }

  private async fetchErrorMessage(response: Response): Promise<string> {
    const text = await response.text();
    if (!text.trim()) {
      return this.httpStatusMessage(response.status);
    }
    try {
      const body = JSON.parse(text) as { message?: string; error?: string };
      return body.message || body.error || this.httpStatusMessage(response.status);
    } catch {
      return text;
    }
  }

  private httpStatusMessage(status: number): string {
    switch (status) {
      case 400:
        return '请求参数不正确，请刷新页面后重试。';
      case 401:
        return '本地会话已失效，请刷新页面后重试。';
      case 404:
        return '请求的本地资源不存在，请刷新页面后重试。';
      case 409:
        return '当前操作与正在运行的任务冲突，请稍后重试。';
      case 500:
        return '本地 API 处理失败，请查看后端日志。';
      default:
        return `本地 API 请求失败（HTTP ${status}）。`;
    }
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function loadTabId(): string {
  const fallback = createTabId();
  if (typeof sessionStorage === 'undefined') {
    return fallback;
  }
  const existing = sessionStorage.getItem(tabIdStorageKey);
  if (existing) {
    return existing;
  }
  sessionStorage.setItem(tabIdStorageKey, fallback);
  return fallback;
}

function createTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
