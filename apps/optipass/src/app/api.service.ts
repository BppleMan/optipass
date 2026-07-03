import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import type {
  ExecutionPlan,
  GroupDecision,
  RevealCredentialsResponse,
  ScanProgress,
  ScanProgressEvent,
  ScanResult,
  ScanSnapshot
} from '@optimize-password/core';
import { firstValueFrom } from 'rxjs';

export interface SessionResponse {
  token: string;
  accountName?: string;
  apiBaseUrl: string;
  enableMutations: boolean;
  forceDryRun: boolean;
  hasServiceAccountToken: boolean;
  supportsDesktopAuth: boolean;
}

export interface ScanStartResponse {
  scanId: string;
  mode: 'live' | 'mock';
  progress: ScanProgress;
}

export interface ExecuteActionResult {
  itemId: string;
  action: string;
  ok: boolean;
  dryRun?: boolean;
  skipped?: boolean;
  error?: string;
}

export interface ExecuteResponse {
  plan?: ExecutionPlan;
  scan?: ScanResult;
  results?: ExecuteActionResult[];
  blocked?: boolean;
  error?: string;
  dryRun?: boolean;
  dryRunKey?: string;
  scanInvalidated?: boolean;
  completedGroupId?: string;
  mutated?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  readonly session = signal<SessionResponse | undefined>(undefined);

  constructor(private readonly http: HttpClient) {}

  async loadSession(): Promise<SessionResponse> {
    const session = await this.request(firstValueFrom(this.http.get<SessionResponse>('/api/session')));
    this.session.set(session);
    return session;
  }

  async startScan(options: { accountName?: string; mode?: 'live' | 'mock' }): Promise<ScanStartResponse> {
    return this.request(firstValueFrom(
      this.http.post<ScanStartResponse>(
        '/api/scan',
        { accountName: options.accountName || undefined, mode: options.mode ?? 'live' },
        { headers: this.headers() }
      )
    ));
  }

  async loadScan(): Promise<ScanSnapshot> {
    return this.request(firstValueFrom(this.http.get<ScanSnapshot>('/api/scan', { headers: this.headers() })));
  }

  async analyze(scanId: string): Promise<ScanResult> {
    return this.request(firstValueFrom(
      this.http.post<ScanResult>('/api/analyze', { scanId }, { headers: this.headers() })
    ));
  }

  async revealCredentials(scanId: string, itemId: string): Promise<RevealCredentialsResponse> {
    return this.request(firstValueFrom(
      this.http.post<RevealCredentialsResponse>(
        `/api/items/${encodeURIComponent(itemId)}/reveal`,
        { scanId },
        { headers: this.headers() }
      )
    ));
  }

  async streamScanEvents(scanId: string, onEvent: (event: ScanProgressEvent) => void): Promise<void> {
    const response = await fetch(`/api/scan/events?scanId=${encodeURIComponent(scanId)}`, {
      headers: this.fetchHeaders(),
      cache: 'no-store'
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

    while (true) {
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
          onEvent(JSON.parse(data) as ScanProgressEvent);
        }
      }
    }
  }

  async createPlan(decision: GroupDecision): Promise<ExecutionPlan> {
    return this.request(firstValueFrom(this.http.post<ExecutionPlan>('/api/plan', decision, { headers: this.headers() })));
  }

  async execute(decision: GroupDecision & {
    confirmPermanentDelete?: boolean;
    permanentDeleteConfirmationPhrase?: string;
    confirmedDryRunKey?: string;
    dryRun?: boolean;
  }): Promise<ExecuteResponse> {
    return this.request(firstValueFrom(this.http.post<ExecuteResponse>('/api/execute', decision, { headers: this.headers() })));
  }

  async clearScan(): Promise<{ ok: boolean }> {
    return this.request(firstValueFrom(this.http.post<{ ok: boolean }>('/api/scan/clear', {}, { headers: this.headers() })));
  }

  private headers(): HttpHeaders {
    const token = this.session()?.token;
    return token ? new HttpHeaders({ 'x-session-token': token }) : new HttpHeaders();
  }

  private fetchHeaders(): HeadersInit {
    const token = this.session()?.token;
    return token ? { 'x-session-token': token } : {};
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
