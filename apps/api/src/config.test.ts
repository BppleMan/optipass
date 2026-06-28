import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "./config.js";

const originalEnv = { ...process.env };

describe("readConfig", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("allows mutations only when explicitly enabled and not force-dry-run locked", () => {
    process.env.OP_ENABLE_MUTATIONS = "true";
    process.env.OP_FORCE_DRY_RUN = undefined;
    process.env.APP_SESSION_TOKEN = "test-token";

    expect(readConfig().enableMutations).toBe(true);
    expect(readConfig().forceDryRun).toBe(false);
  });

  it("forces mutations off when OP_FORCE_DRY_RUN is enabled", () => {
    process.env.OP_ENABLE_MUTATIONS = "true";
    process.env.OP_FORCE_DRY_RUN = "true";
    process.env.APP_SESSION_TOKEN = "test-token";

    const config = readConfig();

    expect(config.enableMutations).toBe(false);
    expect(config.forceDryRun).toBe(true);
  });
});
