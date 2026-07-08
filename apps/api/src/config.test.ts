import { afterEach, describe, expect, it } from "vitest";
import { defaultWebDistDir, readConfig } from "./config.js";

const originalEnv = { ...process.env };

describe("readConfig", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("does not use environment variables to enable mutations", () => {
    process.env.OP_ENABLE_MUTATIONS = "true";
    process.env.OP_FORCE_DRY_RUN = "true";
    process.env.APP_SESSION_TOKEN = "test-token";

    const config = readConfig();

    expect(config.enableMutations).toBe(false);
  });

  it("always binds the local API to loopback", () => {
    process.env.HOST = "0.0.0.0";
    process.env.APP_SESSION_TOKEN = "test-token";

    expect(readConfig().host).toBe("127.0.0.1");
  });

  it("reads local app mode and idle shutdown settings", () => {
    process.env.APP_MODE = "tauri";
    process.env.APP_IDLE_SHUTDOWN_MS = "30000";
    process.env.APP_SESSION_TOKEN = "test-token";

    const config = readConfig();

    expect(config.mode).toBe("tauri");
    expect(config.idleShutdownMs).toBe(30000);
  });

  it("defaults production UI assets to the web Angular app", () => {
    expect(defaultWebDistDir()).toContain("apps/web/dist/web/browser");
  });
});
