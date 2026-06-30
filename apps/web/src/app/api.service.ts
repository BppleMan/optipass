import { HttpClient, HttpErrorResponse, HttpHeaders } from "@angular/common/http";
import { Injectable, signal } from "@angular/core";
import { ExecutionPlan, GroupDecision, ScanResult } from "@optimize-password/core";
import { firstValueFrom } from "rxjs";

interface SessionResponse {
  token: string;
  accountName?: string;
  apiBaseUrl: string;
  enableMutations: boolean;
  forceDryRun: boolean;
  hasServiceAccountToken: boolean;
  supportsDesktopAuth: boolean;
}

@Injectable({ providedIn: "root" })
export class ApiService {
  readonly session = signal<SessionResponse | undefined>(undefined);

  constructor(private readonly http: HttpClient) {}

  async loadSession(): Promise<SessionResponse> {
    const session = await this.request(firstValueFrom(this.http.get<SessionResponse>("/api/session")));
    this.session.set(session);
    return session;
  }

  async scan(options: { accountName?: string; mode?: "live" | "mock" }): Promise<ScanResult> {
    return this.request(firstValueFrom(
      this.http.post<ScanResult>(
        "/api/scan",
        { accountName: options.accountName || undefined, mode: options.mode ?? "live" },
        { headers: this.headers() }
      )
    ));
  }

  async createPlan(decision: GroupDecision): Promise<ExecutionPlan> {
    return this.request(firstValueFrom(this.http.post<ExecutionPlan>("/api/plan", decision, { headers: this.headers() })));
  }

  async skipGroup(scanId: string, groupId: string): Promise<{ skippedGroupId: string; restorableSkippedGroupCount: number; scan: ScanResult }> {
    return this.request(firstValueFrom(
      this.http.post<{ skippedGroupId: string; restorableSkippedGroupCount: number; scan: ScanResult }>(
        `/api/groups/${encodeURIComponent(groupId)}/skip`,
        { scanId },
        { headers: this.headers() }
      )
    ));
  }

  async restoreSkippedGroup(scanId: string): Promise<{ restoredGroupId: string; restorableSkippedGroupCount: number; scan: ScanResult }> {
    return this.request(firstValueFrom(
      this.http.post<{ restoredGroupId: string; restorableSkippedGroupCount: number; scan: ScanResult }>(
        "/api/groups/restore-skipped",
        { scanId },
        { headers: this.headers() }
      )
    ));
  }

  async clearScan(): Promise<{ ok: boolean }> {
    return this.request(firstValueFrom(this.http.post<{ ok: boolean }>("/api/scan/clear", {}, { headers: this.headers() })));
  }

  async execute(decision: GroupDecision & {
    confirmPermanentDelete?: boolean;
    permanentDeleteConfirmationPhrase?: string;
    confirmedDryRunKey?: string;
    dryRun?: boolean;
  }): Promise<unknown> {
    return this.request(firstValueFrom(this.http.post<unknown>("/api/execute", decision, { headers: this.headers() })));
  }

  private headers(): HttpHeaders {
    const token = this.session()?.token;
    return token ? new HttpHeaders({ "x-session-token": token }) : new HttpHeaders();
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
        return "无法连接本地 API，请确认后端服务正在运行。";
      }
      const body = error.error as unknown;
      if (body && typeof body === "object" && "message" in body) {
        return String((body as { message: unknown }).message);
      }
      if (body && typeof body === "object" && "error" in body) {
        return String((body as { error: unknown }).error);
      }
      if (typeof body === "string" && body.trim()) {
        return body;
      }
      return this.httpStatusMessage(error.status);
    }
    if (error instanceof Error) {
      return error.message || "操作失败，请稍后重试。";
    }
    return "操作失败，请稍后重试。";
  }

  private httpStatusMessage(status: number): string {
    switch (status) {
      case 400:
        return "请求参数不正确，请刷新页面后重试。";
      case 401:
        return "本地会话已失效，请刷新页面后重试。";
      case 404:
        return "请求的本地资源不存在，请刷新页面后重试。";
      case 409:
        return "当前操作与正在运行的任务冲突，请稍后重试。";
      case 500:
        return "本地 API 处理失败，请查看后端日志。";
      default:
        return `本地 API 请求失败（HTTP ${status}）。`;
    }
  }
}
