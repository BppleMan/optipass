import { spawn } from "node:child_process";
import { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createApiServer } from "./app.js";
import { AppMode, defaultWebDistDir, readConfig } from "./config.js";
import { acquireRuntimeLock, createRuntimeManifest } from "./local-runtime.js";
import { OnePasswordService } from "./onepassword.js";

interface CliOptions {
  host: string;
  port: number;
  mode: AppMode;
  openBrowser: boolean;
  webDistDir: string;
}

const options = parseCliOptions(process.argv.slice(2));
const lock = await acquireRuntimeLock();

if (!lock.acquired) {
  if (lock.manifest) {
    console.log(`Optipass is already running at ${lock.manifest.url}`);
    if (options.openBrowser) {
      openBrowser(lock.manifest.url);
    }
  } else {
    console.error("Optipass runtime is locked by another process.");
  }
  process.exit(0);
}

let stopping = false;
const config = {
  ...readConfig(),
  host: options.host,
  port: options.port,
  mode: options.mode,
  webDistDir: options.webDistDir
};

const server = await createApiServer({
  config,
  onePassword: new OnePasswordService(),
  lifecycle: {
    shutdown: {
      enabled: true,
      onShutdown: () => stop("requested")
    }
  }
});

await server.listen({ host: config.host, port: config.port });
const address = server.server.address();
if (!address || typeof address === "string") {
  throw new Error("Unable to resolve the local API listener address.");
}

config.port = (address as AddressInfo).port;
const manifest = createRuntimeManifest({
  pid: process.pid,
  host: config.host,
  port: config.port,
  token: config.sessionToken,
  mode: config.mode ?? "browser-serve"
});
await lock.writeManifest(manifest);

server.log.info(`Optipass local app: ${manifest.url}`);
if (options.openBrowser) {
  openBrowser(manifest.url);
}

process.once("SIGINT", () => {
  void stop("signal").then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop("signal").then(() => process.exit(0));
});

async function stop(reason: "requested" | "signal"): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  server.log.info({ reason }, "Stopping Optipass local app");
  await server.close();
  await lock.release();
}

function parseCliOptions(args: string[]): CliOptions {
  const getValue = (name: string): string | undefined => {
    const flagIndex = args.indexOf(name);
    if (flagIndex >= 0) {
      return args[flagIndex + 1];
    }
    const withEquals = args.find((arg) => arg.startsWith(`${name}=`));
    return withEquals?.slice(name.length + 1);
  };

  return {
    host: "127.0.0.1",
    port: Number(getValue("--port") ?? process.env.PORT ?? "0"),
    mode: readMode(getValue("--mode")),
    openBrowser: args.includes("--open") || process.env.OPEN_BROWSER === "true",
    webDistDir: resolve(getValue("--web-dist") ?? process.env.WEB_DIST_DIR ?? defaultWebDistDir())
  };
}

function readMode(value: string | undefined): AppMode {
  const mode = value ?? process.env.APP_MODE;
  if (mode === "tauri" || mode === "browser-dev" || mode === "browser-serve") {
    return mode;
  }
  return "browser-serve";
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}
