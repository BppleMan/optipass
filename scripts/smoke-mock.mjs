import { spawn } from "node:child_process";

const port = Number(process.env.SMOKE_PORT || "3423");
const token = "mock-smoke-token";
const baseUrl = `http://127.0.0.1:${port}`;

const server = spawn("pnpm", ["--filter", "@optimize-password/api", "start"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    APP_SESSION_TOKEN: token,
    OP_ACCOUNT_NAME: "",
    OP_ENABLE_MUTATIONS: "",
    OP_FORCE_DRY_RUN: "true",
    OP_SERVICE_ACCOUNT_TOKEN: "",
    PORT: String(port)
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

try {
  await waitForHealth();
  const result = await runChecks();
  console.log(JSON.stringify(result, null, 2));
} finally {
  server.kill("SIGINT");
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Smoke server exited early.\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await sleep(200);
  }

  throw new Error(`Timed out waiting for smoke server.\n${serverOutput}`);
}

async function runChecks() {
  const index = await get("/");
  assert(index.status === 200 && String(index.body).includes("<op-root>"), `index failed: ${index.status}`);
  const csp = index.headers.get("content-security-policy") || "";
  assert(
    csp.includes("default-src") && csp.includes("script-src") && csp.includes("object-src"),
    `missing CSP: ${csp}`
  );

  const session = await get("/api/session");
  assert(session.status === 200, `session failed: ${session.status}`);
  assert(session.body.token === token, "session token mismatch");
  assert(session.body.forceDryRun === true, "OP_FORCE_DRY_RUN was not reflected by /api/session");
  assert(session.body.enableMutations === false, "mutations should be disabled during mock smoke");

  const unauthorized = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "mock" })
  });
  assert(unauthorized.status === 401, `unauthorized scan expected 401, got ${unauthorized.status}`);

  const mockScan = await post("/api/scan", { mode: "mock" });
  assert(mockScan.status === 200, `mock scan failed: ${mockScan.status}`);
  assert(mockScan.body.groups.length > 0, "mock scan returned no duplicate groups");
  const mockScanJson = JSON.stringify(mockScan.body);
  assert(!mockScanJson.includes("AKIA-MOCK-KEY"), "mock scan leaked a comparable field value");
  assert(!mockScanJson.includes("mock-aws-secret"), "mock scan leaked a secret hash");

  const liveScan = await post("/api/scan", { mode: "live" });
  assert(liveScan.status === 400, `live scan without auth expected 400, got ${liveScan.status}`);
  assert(
    String(liveScan.body.message || "").includes("Missing 1Password account name"),
    "live scan without auth did not report the missing account guard"
  );

  return {
    ok: true,
    baseUrl,
    checks: {
      index: index.status,
      session: session.status,
      unauthorizedScan: unauthorized.status,
      mockGroups: mockScan.body.groups.length,
      liveWithoutAuth: liveScan.status
    }
  };
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return responseBody(response);
}

async function post(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-session-token": token
    },
    body: JSON.stringify(payload)
  });
  return responseBody(response);
}

async function responseBody(response) {
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep the raw text body.
  }

  return {
    status: response.status,
    headers: response.headers,
    body
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
