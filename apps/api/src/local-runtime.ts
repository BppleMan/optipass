import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppMode } from "./config.js";

export interface RuntimeManifest {
  pid: number;
  host: string;
  port: number;
  token: string;
  mode: AppMode;
  startedAt: string;
  url: string;
}

export interface RuntimeManifestInput {
  pid: number;
  host: string;
  port: number;
  token: string;
  mode: AppMode;
}

export interface RuntimeManifestLookup {
  manifest?: RuntimeManifest;
}

export interface RuntimePaths {
  dir: string;
  lockFile: string;
  manifestFile: string;
}

export interface RuntimeLock {
  paths: RuntimePaths;
  manifest?: RuntimeManifest;
  acquired: boolean;
  writeManifest(manifest: RuntimeManifest): Promise<void>;
  release(): Promise<void>;
}

export function defaultRuntimePaths(): RuntimePaths {
  const dir = join(tmpdir(), "optipass-runtime");
  return {
    dir,
    lockFile: join(dir, "optipass.lock"),
    manifestFile: join(dir, "manifest.json")
  };
}

export function createRuntimeManifest(input: RuntimeManifestInput): RuntimeManifest {
  return {
    ...input,
    startedAt: new Date().toISOString(),
    url: `http://${input.host}:${input.port}/`
  };
}

export function createSessionToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function acquireRuntimeLock(paths = defaultRuntimePaths()): Promise<RuntimeLock> {
  await mkdir(paths.dir, { recursive: true });

  const existing = await readRuntimeManifest(paths);
  if (existing.manifest && isProcessAlive(existing.manifest.pid)) {
    return existingRuntimeLock(paths, existing.manifest);
  }

  if (existing.manifest) {
    await clearRuntimeFiles(paths);
  }

  try {
    const handle = await open(paths.lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
    await handle.writeFile(String(process.pid));
    return acquiredRuntimeLock(paths, handle);
  } catch (error) {
    const lookup = await readRuntimeManifest(paths);
    if (lookup.manifest && isProcessAlive(lookup.manifest.pid)) {
      return existingRuntimeLock(paths, lookup.manifest);
    }
    await clearRuntimeFiles(paths);
    const handle = await open(paths.lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
    await handle.writeFile(String(process.pid));
    return acquiredRuntimeLock(paths, handle);
  }
}

export async function readRuntimeManifest(paths = defaultRuntimePaths()): Promise<RuntimeManifestLookup> {
  try {
    const raw = await readFile(paths.manifestFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeManifest>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.host === "string" &&
      typeof parsed.port === "number" &&
      typeof parsed.token === "string" &&
      isAppMode(parsed.mode) &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.url === "string"
    ) {
      return { manifest: parsed as RuntimeManifest };
    }
  } catch {
    return {};
  }
  return {};
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquiredRuntimeLock(paths: RuntimePaths, handle: FileHandle): RuntimeLock {
  return {
    paths,
    acquired: true,
    async writeManifest(manifest) {
      await mkdir(dirname(paths.manifestFile), { recursive: true });
      await writeFile(paths.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    },
    async release() {
      await handle.close();
      await clearRuntimeFiles(paths);
    }
  };
}

function existingRuntimeLock(paths: RuntimePaths, manifest: RuntimeManifest): RuntimeLock {
  return {
    paths,
    manifest,
    acquired: false,
    async writeManifest() {
      throw new Error("Cannot write manifest without owning the runtime lock.");
    },
    async release() {
    }
  };
}

async function clearRuntimeFiles(paths: RuntimePaths): Promise<void> {
  await rm(paths.lockFile, { force: true });
  await rm(paths.manifestFile, { force: true });
}

function isAppMode(value: unknown): value is AppMode {
  return value === "browser-dev" || value === "browser-serve" || value === "tauri";
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
