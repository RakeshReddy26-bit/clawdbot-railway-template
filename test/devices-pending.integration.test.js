// Behavioral test for the /setup "Refresh pending devices" helper.
//
// Spawns the real src/server.js with a stub CLI that prints what OpenClaw 2026.10.1
// prints for `devices list` (a table with a "Request" column) and `devices list --json`
// (structured JSON, preceded by a stderr warning). The helper must find the pending
// request id in both cases and must not leak paired-device data to the browser.

import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.js");
const SETUP_PASSWORD = "test-setup-password";
const REQUEST_ID = "70e3afe1-005f-4633-8daa-8d87cd7df249";
const PAIRED_SECRET = "paired-device-secret-should-not-leak";

const TABLE_OUTPUT = [
  "Pending (1)",
  "┌──────────────────────────────────────┬────────────────┬──────────┐",
  "│ Request                              │ Device         │ Status   │",
  "├──────────────────────────────────────┼────────────────┼──────────┤",
  `│ ${REQUEST_ID} │ 82aa28ce3da472 │ new      │`,
  "└──────────────────────────────────────┴────────────────┴──────────┘",
].join("\n");

const JSON_OUTPUT = JSON.stringify({
  pending: [
    {
      requestId: REQUEST_ID,
      deviceId: "82aa28ce3da4720e7198bccd57a5d25e",
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      platform: "MacIntel",
    },
  ],
  paired: [{ deviceId: "aaaa", tokens: [{ token: PAIRED_SECRET }] }],
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        headers: { Authorization: "Basic " + Buffer.from("admin:" + SETUP_PASSWORD).toString("base64") },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function startWrapper(stubSource) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-devices-test-"));
  const stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
  const stub = path.join(tmpDir, "openclaw-stub.mjs");
  fs.writeFileSync(stub, stubSource);

  const port = await freePort();
  const child = childProcess.spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(port),
      SETUP_PASSWORD,
      OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKSPACE_DIR: path.join(tmpDir, "workspace"),
      INTERNAL_GATEWAY_PORT: String(await freePort()),
      OPENCLAW_ENTRY: stub,
      OPENCLAW_NODE: process.execPath,
    },
    stdio: "ignore",
  });

  for (let i = 0; i < 100; i++) {
    try {
      const r = await get(port, "/setup/healthz");
      if (r.status === 200) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port,
    stop() {
      child.kill("SIGKILL");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// argv: [node, stub, ...cliArgs]
const STUB_2026_10 = `
const args = process.argv.slice(2);
if (args[0] === "gateway") { setInterval(() => {}, 1 << 30); }
else if (args[0] === "devices" && args[1] === "list" && args.includes("--json")) {
  process.stderr.write("warning: something noisy on stderr\\n");
  process.stdout.write(${JSON.stringify(JSON_OUTPUT)} + "\\n");
}
else if (args[0] === "devices" && args[1] === "list") { process.stdout.write(${JSON.stringify(TABLE_OUTPUT)} + "\\n"); }
else { process.exit(0); }
`;

// Older CLI: no --json support (exits non-zero), text output with "requestId: ...".
const STUB_LEGACY = `
const args = process.argv.slice(2);
if (args[0] === "gateway") { setInterval(() => {}, 1 << 30); }
else if (args[0] === "devices" && args[1] === "list" && args.includes("--json")) { process.stderr.write("error: unknown option '--json'\\n"); process.exit(1); }
else if (args[0] === "devices" && args[1] === "list") { process.stdout.write("Pending:\\n- requestId: legacyReq123 device abc\\n"); }
else { process.exit(0); }
`;

test("2026.10.1: pending browser request is listed", async () => {
  const w = await startWrapper(STUB_2026_10);
  try {
    const r = await get(w.port, "/setup/api/devices/pending");
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.deepEqual(j.requestIds, [REQUEST_ID]);
    assert.match(j.output, new RegExp(REQUEST_ID));
    assert.match(j.output, /openclaw-control-ui/);
    assert.ok(!r.body.includes(PAIRED_SECRET), "paired-device data must not reach the browser");
  } finally {
    w.stop();
  }
});

test("older CLI without --json: falls back to text parsing", async () => {
  const w = await startWrapper(STUB_LEGACY);
  try {
    const r = await get(w.port, "/setup/api/devices/pending");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body).requestIds, ["legacyReq123"]);
  } finally {
    w.stop();
  }
});

test("pending endpoint still requires the setup password", async () => {
  const w = await startWrapper(STUB_2026_10);
  try {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: w.port, path: "/setup/api/devices/pending" }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject);
    });
    assert.equal(r, 401);
  } finally {
    w.stop();
  }
});
