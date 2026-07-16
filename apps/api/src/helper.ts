import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createApiServer } from "./app.js";
import { ApiConfig, AppMode, readConfig } from "./config.js";
import { createSessionToken } from "./local-runtime.js";
import { OnePasswordService } from "./onepassword.js";
import { createDefaultApplicationServices } from "./application-services.js";
import type { FastifyServerOptions } from "fastify";

export const helperReadyPrefix = "OPTIPASS_READY ";

export interface HelperCliOptions {
  host: string;
  port: number;
  token: string;
}

export interface HelperReadyPayload {
  pid: number;
  host: string;
  port: number;
  token: string;
  mode: "tauri";
  apiBaseUrl: string;
  startedAt: string;
}

export interface StartedHelper {
  ready: HelperReadyPayload;
  stop(): Promise<void>;
}

interface StartHelperOptions {
  args?: string[];
  services?: import("./item-services.js").ApplicationServices;
  logger?: FastifyServerOptions["logger"];
  writeReadyLine?: (line: string) => void;
}

export async function startTauriHelper(options: StartHelperOptions = {}): Promise<StartedHelper> {
  const cli = parseHelperCliOptions(options.args ?? process.argv.slice(2));
  const baseConfig = readConfig();
  const config: ApiConfig = {
    ...baseConfig,
    host: cli.host,
    port: cli.port,
    mode: AppMode.Tauri,
    sessionToken: cli.token,
    webDistDir: undefined,
    webOrigins: [...new Set([...baseConfig.webOrigins, ...tauriWebOrigins()])]
  };

  let stopping = false;
  const onePassword = new OnePasswordService();
  const server = await createApiServer({
    config,
    services: options.services ?? createDefaultApplicationServices(onePassword),
    logger: options.logger,
    lifecycle: {
      shutdown: {
        enabled: true,
        onShutdown: () => stop()
      }
    }
  });

  await server.listen({ host: config.host, port: config.port });
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve the local API listener address.");
  }

  const port = (address as AddressInfo).port;
  const ready = createHelperReadyPayload({
    pid: process.pid,
    host: config.host,
    port,
    token: config.sessionToken
  });
  options.writeReadyLine?.(formatHelperReadyLine(ready));

  process.once("SIGINT", () => {
    void stop().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void stop().then(() => process.exit(0));
  });

  return {
    ready,
    stop
  };

  async function stop(): Promise<void> {
    if (stopping) {
      return;
    }
    stopping = true;
    await server.close();
  }
}

export function parseHelperCliOptions(args: string[]): HelperCliOptions {
  const getValue = (name: string): string => {
    const flagIndex = args.indexOf(name);
    if (flagIndex >= 0) {
      return args[flagIndex + 1] ?? "";
    }
    const withEquals = args.find((arg) => arg.startsWith(`${name}=`));
    return withEquals?.slice(name.length + 1) ?? "";
  };

  return {
    host: "127.0.0.1",
    port: Number(getValue("--port") || process.env.PORT || "0"),
    token: getValue("--token") ?? process.env.APP_SESSION_TOKEN ?? createSessionToken()
  };
}

export function createHelperReadyPayload(input: {
  pid: number;
  host: string;
  port: number;
  token: string;
}): HelperReadyPayload {
  return {
    ...input,
    mode: "tauri",
    apiBaseUrl: `http://${input.host}:${input.port}`,
    startedAt: new Date().toISOString()
  };
}

export function formatHelperReadyLine(payload: HelperReadyPayload): string {
  return `${helperReadyPrefix}${JSON.stringify(payload)}`;
}

function tauriWebOrigins(): string[] {
  return [
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
    "http://127.0.0.1:4200",
    "http://localhost:4200"
  ];
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  startTauriHelper({
    writeReadyLine: (line) => console.log(line)
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
