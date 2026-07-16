import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export enum AppMode {
    BrowserDev = "browser-dev",
    BrowserServe = "browser-serve",
    Tauri = "tauri",
}

export interface ApiConfig {
  host: string;
  port: number;
  mode?: AppMode;
  webOrigins: string[];
  accountName?: string;
  enableMutations: boolean;
  serviceAccountToken?: string;
  sessionToken: string;
  webDistDir?: string;
  idleShutdownMs?: number;
}

export function readConfig(): ApiConfig {
  return {
    host: "127.0.0.1",
    port: Number(process.env.PORT || "3417"),
    mode: readAppMode(),
    webOrigins: readWebOrigins(),
    accountName: process.env.OP_ACCOUNT_NAME,
    enableMutations: false,
    serviceAccountToken: process.env.OP_SERVICE_ACCOUNT_TOKEN,
    sessionToken: process.env.APP_SESSION_TOKEN || randomBytes(24).toString("base64url"),
    webDistDir: process.env.WEB_DIST_DIR || defaultWebDistDir(),
    idleShutdownMs: readPositiveNumber("APP_IDLE_SHUTDOWN_MS")
  };
}

export function defaultWebDistDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist/web/browser");
}

function readWebOrigins(): string[] {
  const configured = process.env.WEB_ORIGINS || process.env.WEB_ORIGIN;
  if (configured) {
    return configured
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  }
  return ["http://127.0.0.1:4200", "http://localhost:4200"];
}

function readAppMode(): AppMode {
  const mode = process.env.APP_MODE;
  if (mode === "browser-dev" || mode === "browser-serve" || mode === "tauri") {
    return mode as AppMode;
  }
  return AppMode.BrowserDev;
}

function readPositiveNumber(name: string): number {
  const value = process.env[name];
  if (!value) {
    return 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
