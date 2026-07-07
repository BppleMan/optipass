import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer, PasswordService } from "./app.js";
import {
  formatHelperReadyLine,
  helperReadyPrefix,
  parseHelperCliOptions,
} from "./helper.js";

const originalEnv = { ...process.env };

function createService(): PasswordService {
  return {
    scan: vi.fn(),
    revealCredentials: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
    copyToVaultAndArchiveSource: vi.fn(),
    clearCache: vi.fn()
  };
}

describe("tauri helper", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("parses helper CLI options and generates a token when none is provided", () => {
    const options = parseHelperCliOptions(["--port", "0"]);

    expect(options).toMatchObject({
      host: "127.0.0.1",
      port: 0
    });
    expect(options.token).toEqual(expect.any(String));
  });

  it("formats a machine-readable ready line", () => {
    const line = formatHelperReadyLine({
      pid: 42,
      host: "127.0.0.1",
      port: 49152,
      token: "session-token",
      mode: "tauri",
      apiBaseUrl: "http://127.0.0.1:49152",
      startedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(line.startsWith(helperReadyPrefix)).toBe(true);
    expect(JSON.parse(line.slice(helperReadyPrefix.length))).toMatchObject({
      pid: 42,
      mode: "tauri",
      apiBaseUrl: "http://127.0.0.1:49152"
    });
  });

  it("protects the Tauri helper session endpoint with the injected token", async () => {
    const app = await createApiServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        mode: "tauri",
        webOrigins: ["http://tauri.localhost"],
        enableMutations: false,
        forceDryRun: true,
        sessionToken: "helper-token"
      },
      onePassword: createService(),
      logger: false,
      lifecycle: {
        shutdown: {
          enabled: true
        }
      }
    });

    try {
      const unauthenticatedSession = await app.inject({
        method: "GET",
        url: "/api/session"
      });
      expect(unauthenticatedSession.statusCode).toBe(401);

      const authenticatedSession = await app.inject({
        method: "GET",
        url: "/api/session",
        headers: { "x-session-token": "helper-token" }
      });
      expect(authenticatedSession.statusCode).toBe(200);
      expect(authenticatedSession.json()).toMatchObject({
        token: "helper-token",
        mode: "tauri",
        capabilities: {
          staticUi: false,
          canShutdown: true,
          shell: "tauri"
        }
      });
    } finally {
      await app.close();
    }
  });
});
