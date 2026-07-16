import { spawn } from "node:child_process";

const port = Number(process.env.SMOKE_PORT || "3423");
const token = "mock-smoke-token";
const baseUrl = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ["dist/server.js"], {
  cwd: new URL("../apps/api", import.meta.url),
  env: {
    ...process.env,
    APP_SESSION_TOKEN: token,
    OP_ACCOUNT_NAME: "",
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
  assert(index.status === 200 && String(index.body).includes("<app-root>"), `index failed: ${index.status}`);
  const csp = index.headers.get("content-security-policy") || "";
  assert(
    csp.includes("default-src") && csp.includes("script-src") && csp.includes("object-src"),
    `missing CSP: ${csp}`
  );

  const session = await get("/api/session");
  assert(session.status === 200, `session failed: ${session.status}`);
  assert(session.body.token === token, "session token mismatch");
  assert(session.body.enableMutations === false, "mutations should be disabled by default");
  const writableSession = await patch("/api/session/mutations", { enableMutations: true });
  assert(writableSession.status === 200, `mutation enable failed: ${writableSession.status}`);
  assert(writableSession.body.enableMutations === true, "mutation switch did not enable writes");
  const readonlySession = await patch("/api/session/mutations", { enableMutations: false });
  assert(readonlySession.status === 200, `mutation disable failed: ${readonlySession.status}`);
  assert(readonlySession.body.enableMutations === false, "mutation switch did not disable writes");

  const unauthorized = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "mock" })
  });
  assert(unauthorized.status === 401, `unauthorized scan expected 401, got ${unauthorized.status}`);

  const mockScanStart = await post("/api/scan", { mode: "mock" });
  assert(mockScanStart.status === 200, `mock scan failed: ${mockScanStart.status}`);
  const mockScan = await waitForScan();
  const mockAnalysis = await post("/api/analyze", { scanId: mockScan.body.scanId });
  assert(mockAnalysis.status === 200, `mock analysis failed: ${mockAnalysis.status}`);
  assert(mockAnalysis.body.groups.length > 0, "mock scan returned no duplicate groups");
  const mockScanJson = JSON.stringify(mockAnalysis.body);
  assert(!mockScanJson.includes("AKIA-MOCK-KEY"), "mock analysis leaked a comparable field value");
  assert(!mockScanJson.includes("mock-aws-secret"), "mock analysis leaked a secret hash");
  const group = mockAnalysis.body.groups[0];
  const draft = {
    storeSnapshotId: mockAnalysis.body.scanId,
    storeVersion: mockAnalysis.body.storeVersion,
    groups: [{
      groupId: group.id,
      items: group.itemIds.map((itemId, index) => ({
        itemId,
        disposition: index === 0 ? "keep" : "archive",
        removeTags: []
      }))
    }]
  };
  const plan = await post("/api/plan", draft);
  assert(plan.status === 200, `plan failed: ${plan.status}`);
  const execution = await post("/api/action-executions/start", {
    planId: plan.body.planId,
    planHash: plan.body.planHash,
    dryRunSpeedMultiplier: 10
  });
  assert(execution.status === 200, `execution start failed: ${execution.status}`);
  assert(execution.body.writeEnabled === false, "mock smoke execution should be dry-run");
  assert(
    JSON.stringify(execution.body.plan.groups[0].steps.map((step) => step.actionId)) ===
      JSON.stringify(plan.body.groups[0].steps.map((step) => step.actionId)),
    "execution did not reuse the previewed action ids"
  );
  await waitForExecution(execution.body.executionId);

  const liveScan = await post("/api/scan", { mode: "live" });
  assert(liveScan.status === 400, `live scan without auth expected 400, got ${liveScan.status}`);
  assert(
    String(liveScan.body.message || "").includes("Desktop App 授权需要账户名"),
    "live scan without auth did not report the missing account guard"
  );

  return {
    ok: true,
    baseUrl,
    checks: {
      index: index.status,
      session: session.status,
      unauthorizedScan: unauthorized.status,
      mockGroups: mockAnalysis.body.groups.length,
      actionSteps: plan.body.statistics.stepCount,
      liveWithoutAuth: liveScan.status
    }
  };
}

async function waitForExecution(executionId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const execution = await getWithToken(`/api/action-executions/${executionId}`);
    if (execution.status === 200 && execution.body.status === "completed") {
      return execution;
    }
    if (execution.status === 200 && (execution.body.status === "failed" || execution.body.status === "stopped")) {
      throw new Error(`Execution ended unexpectedly: ${execution.body.status}`);
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for execution ${executionId}.`);
}

async function waitForScan() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const scan = await getWithToken("/api/scan");
    if (scan.status === 200) {
      return scan;
    }
    await sleep(50);
  }
  throw new Error("Timed out waiting for the completed scan snapshot.");
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return responseBody(response);
}

async function getWithToken(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "x-session-token": token
    }
  });
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

async function patch(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
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
