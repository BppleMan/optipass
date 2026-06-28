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
      const body = error.error as unknown;
      if (body && typeof body === "object" && "message" in body) {
        return String((body as { message: unknown }).message);
      }
      if (typeof body === "string" && body.trim()) {
        return body;
      }
      return `${error.status} ${error.statusText}`.trim();
    }
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
