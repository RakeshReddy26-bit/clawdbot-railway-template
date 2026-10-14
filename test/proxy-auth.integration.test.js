// Behavioral tests for the wrapper's auth boundary.
//
// Starts the real src/server.js against a fake OpenClaw gateway that records
// every request it receives, so we can assert exactly which credentials cross
// the wrapper -> gateway boundary. No real OpenClaw build or network is needed:
// OPENCLAW_ENTRY points at a tiny stub that pretends to be the CLI.

import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SETUP_PASSWORD = "test-setup-password-123";
const GATEWAY_TOKEN = "test-gateway-admin-token-456";
const SERVER_JS = new URL("../src/server.js", import.meta.url).pathname;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function basic(password, user = "admin") {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

async function startFakeGateway(port) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ kind: "http", method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ kind: "ws", method: req.method, url: req.url, headers: req.headers, body: "" });
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, seen };
}

async function waitForHealthy(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrapper exited early (${child.exitCode})`);
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/healthz" }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("wrapper did not become healthy");
}

function request(port, { method = "GET", path: reqPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function upgrade(port, { path: reqPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: reqPath,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

let wrapperPort;
let gateway;
let child;
let tmpDir;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-auth-test-"));
  const stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n"); // => isConfigured()

  // Stub CLI: `gateway run` stays alive; every other command (config set ...) succeeds.
  const stub = path.join(tmpDir, "openclaw-stub.mjs");
  fs.writeFileSync(
    stub,
    'if (process.argv[2] === "gateway") { setInterval(() => {}, 1 << 30); } else { process.exit(0); }\n',
  );

  const gatewayPort = await freePort();
  wrapperPort = await freePort();
  gateway = await startFakeGateway(gatewayPort);

  child = childProcess.spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(wrapperPort),
      SETUP_PASSWORD,
      OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKSPACE_DIR: path.join(tmpDir, "workspace"),
      INTERNAL_GATEWAY_HOST: "127.0.0.1",
      INTERNAL_GATEWAY_PORT: String(gatewayPort),
      OPENCLAW_ENTRY: stub,
      OPENCLAW_NODE: process.execPath,
    },
    stdio: "ignore",
  });
  await waitForHealthy(wrapperPort, child);
});

test.after(async () => {
  child?.kill("SIGKILL");
  await new Promise((resolve) => gateway?.server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function lastSeen(url) {
  return [...gateway.seen].reverse().find((r) => r.url === url);
}

function assertNoSetupPassword(record) {
  assert.ok(record, "gateway should have received the request");
  const allHeaders = JSON.stringify(record.headers);
  assert.ok(!allHeaders.includes(SETUP_PASSWORD), "setup password must never reach the gateway");
  assert.ok(
    !allHeaders.includes(Buffer.from(`admin:${SETUP_PASSWORD}`).toString("base64")),
    "Basic credentials must never reach the gateway",
  );
}

// --- Dashboard HTTP: Basic is checked by the wrapper, then replaced by Bearer ---

test("dashboard request without credentials is challenged and never reaches the gateway", async () => {
  const res = await request(wrapperPort, { path: "/no-creds-probe" });
  assert.equal(res.status, 401);
  assert.match(res.headers["www-authenticate"] ?? "", /Basic realm="OpenClaw Dashboard"/);
  assert.equal(lastSeen("/no-creds-probe"), undefined);
});

test("dashboard request with wrong password is rejected and never reaches the gateway", async () => {
  const res = await request(wrapperPort, {
    path: "/wrong-password-probe",
    headers: { Authorization: basic("not-the-password") },
  });
  assert.equal(res.status, 401);
  assert.equal(lastSeen("/wrong-password-probe"), undefined);
});

test("valid Basic login is replaced by the gateway Bearer token upstream", async () => {
  const res = await request(wrapperPort, {
    path: "/control-ui-config.json",
    headers: { Authorization: basic(SETUP_PASSWORD) },
  });
  assert.equal(res.status, 200);
  const seen = lastSeen("/control-ui-config.json");
  assert.equal(seen.headers.authorization, `Bearer ${GATEWAY_TOKEN}`);
  assertNoSetupPassword(seen);
});

test("gateway token is never echoed back to the browser", async () => {
  const res = await request(wrapperPort, {
    path: "/echo-check",
    headers: { Authorization: basic(SETUP_PASSWORD) },
  });
  assert.ok(!JSON.stringify(res.headers).includes(GATEWAY_TOKEN));
  assert.ok(!res.body.includes(GATEWAY_TOKEN));
});

// --- Webhooks: own credentials only, never the gateway admin token ---

test("webhook keeps the caller's own Bearer token unchanged", async () => {
  const res = await request(wrapperPort, {
    method: "POST",
    path: "/hooks/agent",
    headers: { Authorization: "Bearer caller-hook-token", "content-type": "text/plain" },
    body: "ping",
  });
  assert.equal(res.status, 200);
  assert.equal(lastSeen("/hooks/agent").headers.authorization, "Bearer caller-hook-token");
});

test("webhook keeps x-openclaw-token and does not receive the admin token", async () => {
  await request(wrapperPort, {
    method: "POST",
    path: "/hooks/wake",
    headers: { "x-openclaw-token": "caller-hook-token", "content-type": "text/plain" },
    body: "ping",
  });
  const seen = lastSeen("/hooks/wake");
  assert.equal(seen.headers["x-openclaw-token"], "caller-hook-token");
  assert.equal(seen.headers.authorization, undefined);
});

test("unauthenticated webhook call is NOT upgraded to the gateway admin token", async () => {
  await request(wrapperPort, { method: "POST", path: "/hooks/anon", body: "" });
  const seen = lastSeen("/hooks/anon");
  assert.ok(seen, "webhooks bypass the dashboard password and reach the gateway");
  assert.equal(seen.headers.authorization, undefined);
});

test("bare /hooks path is treated as a webhook", async () => {
  await request(wrapperPort, { method: "POST", path: "/hooks", body: "" });
  assert.equal(lastSeen("/hooks").headers.authorization, undefined);
});

// --- Look-alike paths must not inherit the webhook bypass ---

for (const lookalike of ["/hooksX", "/hooks-admin", "/hooksx/anything"]) {
  test(`${lookalike} requires the dashboard password`, async () => {
    const res = await request(wrapperPort, { path: lookalike });
    assert.equal(res.status, 401);
    assert.equal(lastSeen(lookalike), undefined);
  });
}

test("/hooksX with a valid login gets Bearer, not Basic", async () => {
  await request(wrapperPort, {
    path: "/hooksX-authed",
    headers: { Authorization: basic(SETUP_PASSWORD) },
  });
  const seen = lastSeen("/hooksX-authed");
  assert.equal(seen.headers.authorization, `Bearer ${GATEWAY_TOKEN}`);
  assertNoSetupPassword(seen);
});

test("dot-segment path that escapes /hooks does not bypass the dashboard password", async () => {
  const res = await request(wrapperPort, { path: "/hooks/../admin-probe" });
  assert.equal(res.status, 401);
  assert.equal(lastSeen("/hooks/../admin-probe"), undefined);
});

// --- One invariant across tricky paths: the admin token is only ever attached
// to requests that passed the dashboard password. Covers dot segments, encoded
// dots, duplicate slashes, case and encoding variants. ---

const TRICKY_PATHS = [
  "/hooks/%2e%2e/escape-a",
  "/hooks/.%2e/escape-b",
  "/hooks/..%2fescape-c",
  "/hooks%2fescape-d",
  "//hooks/escape-e",
  "/./hooks/escape-f",
  "/escape-g/../hooks/x",
  "/HOOKS/escape-h",
  "/%68ooks/escape-i",
  "/hooks;escape-j",
  "/hooks?escape=k",
];

for (const tricky of TRICKY_PATHS) {
  test(`unauthenticated ${tricky}: rejected, or forwarded without the admin token`, async () => {
    const before = gateway.seen.length;
    const res = await request(wrapperPort, { path: tricky });
    const forwarded = gateway.seen.slice(before);
    if (res.status === 401) {
      assert.equal(forwarded.length, 0, "rejected requests must not reach the gateway");
    } else {
      for (const record of forwarded) {
        assert.notEqual(record.headers.authorization, `Bearer ${GATEWAY_TOKEN}`);
      }
    }
  });
}

// --- Request bodies: only /setup is parsed by the wrapper; everything else streams through ---

test("JSON webhook body reaches the gateway intact", { timeout: 5000 }, async () => {
  const payload = JSON.stringify({ message: "hello from a webhook" });
  const res = await request(wrapperPort, {
    method: "POST",
    path: "/hooks/json-body",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      Authorization: "Bearer caller-hook-token",
    },
    body: payload,
  });
  assert.equal(res.status, 200);
  assert.equal(lastSeen("/hooks/json-body").body, payload);
});

test("authenticated JSON request to the dashboard reaches the gateway intact", { timeout: 5000 }, async () => {
  const payload = JSON.stringify({ hello: "gateway" });
  const res = await request(wrapperPort, {
    method: "POST",
    path: "/dashboard-json-body",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      Authorization: basic(SETUP_PASSWORD),
    },
    body: payload,
  });
  assert.equal(res.status, 200);
  assert.equal(lastSeen("/dashboard-json-body").body, payload);
});

test("/setup API still parses JSON bodies", async () => {
  // "Invalid" (not "Missing") proves the wrapper parsed the JSON body.
  const res = await request(wrapperPort, {
    method: "POST",
    path: "/setup/api/devices/approve",
    headers: { "content-type": "application/json", Authorization: basic(SETUP_PASSWORD) },
    body: JSON.stringify({ requestId: "not a valid id!" }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body, /Invalid device request ID/);
});

// --- WebSocket upgrades ---

test("WebSocket upgrade carrying Basic credentials is forwarded with Bearer only", async () => {
  const status = await upgrade(wrapperPort, {
    path: "/ws-basic-probe",
    headers: { Authorization: basic(SETUP_PASSWORD) },
  });
  assert.equal(status, 101);
  const seen = lastSeen("/ws-basic-probe");
  assert.equal(seen.kind, "ws");
  assert.equal(seen.headers.authorization, `Bearer ${GATEWAY_TOKEN}`);
  assertNoSetupPassword(seen);
});

test("WebSocket upgrade without credentials still receives the gateway token (existing behavior)", async () => {
  const status = await upgrade(wrapperPort, { path: "/ws-plain-probe" });
  assert.equal(status, 101);
  assert.equal(lastSeen("/ws-plain-probe").headers.authorization, `Bearer ${GATEWAY_TOKEN}`);
});
