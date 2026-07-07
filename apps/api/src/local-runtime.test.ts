import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRuntimeLock,
  createRuntimeManifest,
  pathExists,
  readRuntimeManifest,
  RuntimePaths
} from "./local-runtime.js";

describe("local runtime lock", () => {
  let dir: string;
  let paths: RuntimePaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "optipass-runtime-test-"));
    paths = {
      dir,
      lockFile: join(dir, "optipass.lock"),
      manifestFile: join(dir, "manifest.json")
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a runtime manifest and removes it on release", async () => {
    const lock = await acquireRuntimeLock(paths);
    const manifest = createRuntimeManifest({
      pid: process.pid,
      host: "127.0.0.1",
      port: 49152,
      token: "session-token",
      mode: "browser-serve"
    });

    expect(lock.acquired).toBe(true);
    await lock.writeManifest(manifest);

    expect(await readRuntimeManifest(paths)).toEqual(manifest);

    await lock.release();
    expect(await pathExists(paths.lockFile)).toBe(false);
    expect(await pathExists(paths.manifestFile)).toBe(false);
  });

  it("returns the active manifest instead of acquiring a second instance", async () => {
    const first = await acquireRuntimeLock(paths);
    const manifest = createRuntimeManifest({
      pid: process.pid,
      host: "127.0.0.1",
      port: 49152,
      token: "session-token",
      mode: "browser-serve"
    });
    await first.writeManifest(manifest);

    const second = await acquireRuntimeLock(paths);

    expect(second.acquired).toBe(false);
    expect(second.manifest).toEqual(manifest);

    await first.release();
  });
});
