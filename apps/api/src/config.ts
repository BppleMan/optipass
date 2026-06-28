import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ApiConfig {
  host: string;
  port: number;
  webOrigins: string[];
  accountName?: string;
  enableMutations: boolean;
  forceDryRun: boolean;
  serviceAccountToken?: string;
  sessionToken: string;
  webDistDir?: string;
}

export function readConfig(): ApiConfig {
  const forceDryRun = process.env.OP_FORCE_DRY_RUN === "true";
  return {
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || "3417"),
    webOrigins: readWebOrigins(),
    accountName: process.env.OP_ACCOUNT_NAME,
    enableMutations: process.env.OP_ENABLE_MUTATIONS === "true" && !forceDryRun,
    forceDryRun,
    serviceAccountToken: process.env.OP_SERVICE_ACCOUNT_TOKEN,
    sessionToken: process.env.APP_SESSION_TOKEN || randomBytes(24).toString("base64url"),
    webDistDir: process.env.WEB_DIST_DIR || defaultWebDistDir()
  };
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

function defaultWebDistDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}
