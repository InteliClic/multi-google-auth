// Hub mode tests. No network, no real credentials: a temp HUB_DATA_DIR, an empty
// .env inside the temp dir, and fake Google client values. The hub runs in-process
// on a free port (port 0) and is closed in `after`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mga-hub-test-"));
const dataDir = path.join(tmp, "data");
const envFile = path.join(tmp, "test.env");
fs.writeFileSync(envFile, "# empty on purpose: no real .env may be read\n");

// Scrub anything from the outer shell that could point at real data or clients.
for (const k of Object.keys(process.env)) {
  if (/^(HUB_|GOOGLE_CLIENT_|GMAIL_APP_PASSWORD_|TOKENS_DIR$|OAUTH_REDIRECT_URI$|PUBLIC_URL$|PORT$)/.test(k)) {
    delete process.env[k];
  }
}
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: envFile,
  GOOGLE_CLIENT_ID: "123456789012-fake.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fake",
  PUBLIC_URL: "https://hub.example.test",
  HUB_DATA_DIR: dataDir,
  HUB_ACCOUNTS: "aroncorp,personal",
  HUB_ADMIN_EMAILS: "Admin@Example.com",
  HUB_PORT: "0",
});

await import("../src/env.js"); // loads only the empty test .env
const { startHub, hubConfig } = await import("../src/hub.js");
const { registerTools, READ_TOOLS, ALL_TOOLS } = await import("../src/mcp.js");
const { tokensDir } = await import("../src/config.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const SEED_KEY = "seed-" + crypto.randomBytes(24).toString("base64url");
const ADMIN = { "Cf-Access-Authenticated-User-Email": "admin@example.com" };
let hub;
let base;

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const postMcp = (headers = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(initBody),
  });

async function mcpClient(key) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "hub-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const callsLog = () => path.join(dataDir, "log", "calls.jsonl");
const readCalls = () =>
  fs.existsSync(callsLog())
    ? fs.readFileSync(callsLog(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

before(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  const sha256 = crypto.createHash("sha256").update(SEED_KEY).digest("hex");
  fs.writeFileSync(
    path.join(dataDir, "keys.json"),
    JSON.stringify([{ name: "seed", sha256, mode: "read", created_at: new Date().toISOString(), last_used_at: null }])
  );
  hub = await startHub({ firstProbeMs: 60 * 60 * 1000 });
  base = `http://127.0.0.1:${hub.port}`;
});

after(async () => {
  await hub?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the temp data dir is the one in use", () => {
  assert.equal(hub.dataDir, path.resolve(dataDir));
  assert.notEqual(hub.port, 8790);
  assert.equal(tokensDir(), path.join(path.resolve(dataDir), "tokens"));
  assert.ok(fs.existsSync(path.join(dataDir, "log")), "log dir created in the temp dir");
  assert.ok(fs.existsSync(path.join(dataDir, "tokens")), "tokens dir created in the temp dir");
});

test("hub config refuses a missing or unknown HUB_ACCOUNTS", () => {
  assert.throws(() => hubConfig({ accounts: [] }), /HUB_ACCOUNTS is required/);
  assert.throws(() => hubConfig({ accounts: ["aroncorp", "nope"] }), /not in accounts\.json: nope/);
});

test("/health answers 200 with ok:true and leaks no email or key name", async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const text = await r.text();
  const j = JSON.parse(text);
  assert.equal(j.ok, true);
  assert.equal(j.accounts, 2);
  assert.ok("version" in j && "live" in j && "last_probe_at" in j);
  assert.ok(!text.includes("@"), "no email in /health");
  assert.ok(!/aroncorp|personal|seed/.test(text), "no key names in /health");
});

test("/mcp without a key or with a wrong key -> 401 with a generic body", async () => {
  const r1 = await postMcp();
  assert.equal(r1.status, 401);
  assert.equal(r1.headers.get("www-authenticate"), "Bearer");
  const b1 = await r1.text();
  const r2 = await postMcp({ Authorization: "Bearer wrong-key" });
  assert.equal(r2.status, 401);
  const b2 = await r2.text();
  const r3 = await postMcp({ "X-Hub-Key": "also-wrong" });
  assert.equal(r3.status, 401);
  assert.equal(b1, b2, "same body for missing and wrong key");
  assert.equal(b2, await r3.text());
});

test("after 10 wrong keys from one address -> 429, even with a valid key", async () => {
  const ip = { "CF-Connecting-IP": "203.0.113.50" };
  for (let i = 0; i < 10; i++) {
    const r = await postMcp({ ...ip, Authorization: `Bearer wrong-${i}` });
    assert.equal(r.status, 401, `attempt ${i + 1}`);
  }
  const r = await postMcp({ ...ip, Authorization: "Bearer wrong-11" });
  assert.equal(r.status, 429);
  const ok = await postMcp({ ...ip, Authorization: `Bearer ${SEED_KEY}` });
  assert.equal(ok.status, 429);
  // A different address is unaffected.
  const other = await postMcp({ "CF-Connecting-IP": "203.0.113.51", Authorization: `Bearer ${SEED_KEY}` });
  assert.equal(other.status, 200);
  await other.text();
});

test("GET and DELETE /mcp -> 405", async () => {
  for (const method of ["GET", "DELETE"]) {
    const r = await fetch(`${base}/mcp`, { method, headers: { Authorization: `Bearer ${SEED_KEY}` } });
    assert.equal(r.status, 405, method);
  }
});

test("with a valid key, tools/list holds exactly the six read tools and only the served accounts", async () => {
  const client = await mcpClient(SEED_KEY);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS].sort());
    for (const w of ["gmail_create_draft", "calendar_create_event", "assistant_command"]) {
      assert.ok(!tools.some((t) => t.name === w), `${w} must not be exposed`);
    }
    for (const t of tools.filter((x) => x.inputSchema.properties?.account)) {
      assert.deepEqual([...t.inputSchema.properties.account.enum].sort(), ["aroncorp", "personal"], t.name);
    }
    const la = await client.callTool({ name: "list_accounts", arguments: { probe: false } });
    const rows = JSON.parse(la.content[0].text);
    assert.deepEqual(rows.map((r) => r.account).sort(), ["aroncorp", "personal"]);
  } finally {
    await client.close();
  }
});

test("gmail_search: unserved account refused; served account without token is a tool error and is logged", async () => {
  const client = await mcpClient(SEED_KEY);
  try {
    let refused = false;
    try {
      const r = await client.callTool({ name: "gmail_search", arguments: { account: "inteliclic", query: "x" } });
      refused = !!r.isError;
    } catch {
      refused = true;
    }
    assert.ok(refused, "account outside HUB_ACCOUNTS must be refused");

    const before = readCalls().length;
    const r = await client.callTool({
      name: "gmail_search",
      arguments: { account: "aroncorp", query: "from:someone@example.com a secret body", max_results: 3 },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not authorized/);
    const calls = readCalls();
    assert.equal(calls.length, before + 1, "exactly one line appended");
    const last = calls.at(-1);
    assert.equal(last.key, "seed");
    assert.equal(last.tool, "gmail_search");
    assert.equal(last.account, "aroncorp");
    assert.equal(last.ok, false);
    assert.equal(last.args.max_results, 3);
    assert.ok(last.args.query.length <= 80);
    assert.ok(typeof last.ms === "number" && last.error.length <= 200);
    assert.ok(fs.existsSync(callsLog()), "call log is in the temp dir");
    const keys = JSON.parse(fs.readFileSync(path.join(dataDir, "keys.json"), "utf8"));
    assert.ok(keys.find((k) => k.name === "seed").last_used_at, "last_used_at updated");
  } finally {
    await client.close();
  }
});

test("admin gate: 403 without the Access header or for an unlisted email", async () => {
  for (const p of ["/admin", "/", "/auth/aroncorp", "/approve/1", "/oauth2callback?code=x&state=y"]) {
    const r = await fetch(base + p, { redirect: "manual" });
    assert.equal(r.status, 403, p);
    assert.equal(await r.text(), "Forbidden");
  }
  const other = await fetch(`${base}/admin`, { headers: { "Cf-Access-Authenticated-User-Email": "intruder@example.com" } });
  assert.equal(other.status, 403);
  const ok = await fetch(`${base}/admin`, { headers: { "Cf-Access-Authenticated-User-Email": "ADMIN@example.com" } });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /Caller keys/);
  assert.ok(!html.includes(SEED_KEY), "admin page never shows a key");
  const approve = await fetch(`${base}/approve/1`, { headers: ADMIN });
  assert.equal(approve.status, 501);
  assert.match(await approve.text(), /not built yet \(slice 2\)/);
});

test("POST /admin/keys creates a working key, stores only its hash; revoke stops it; CSRF enforced", async () => {
  const adminHtml = await (await fetch(`${base}/admin`, { headers: ADMIN })).text();
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(adminHtml)?.[1];
  assert.ok(csrf, "form token present");
  const form = (o) => new URLSearchParams(o).toString();
  const post = (p, body, extra = {}) =>
    fetch(base + p, {
      method: "POST",
      redirect: "manual",
      headers: { ...ADMIN, "Content-Type": "application/x-www-form-urlencoded", ...extra },
      body: form(body),
    });

  assert.equal((await post("/admin/keys", { name: "nocsrf", mode: "read" })).status, 403, "no form token");
  assert.equal((await post("/admin/keys", { name: "badcsrf", mode: "read", csrf: "0".repeat(64) })).status, 403);
  assert.equal(
    (await post("/admin/keys", { name: "xorigin", mode: "read", csrf }, { Origin: "https://evil.example" })).status,
    403,
    "foreign Origin"
  );
  assert.equal((await post("/admin/keys", { name: "w", mode: "write", csrf })).status, 400, "only read mode");
  assert.equal((await post("/admin/keys", { name: "bad name!", mode: "read", csrf })).status, 400);

  const created = await post("/admin/keys", { name: "laptop", mode: "read", csrf }, { Origin: "https://hub.example.test" });
  assert.equal(created.status, 200);
  const page = await created.text();
  const key = /Authorization: Bearer ([A-Za-z0-9_-]{43})</.exec(page)?.[1];
  assert.ok(key, "key shown once with the header line");
  assert.equal((await post("/admin/keys", { name: "laptop", mode: "read", csrf })).status, 409, "unique name");

  const stored = fs.readFileSync(path.join(dataDir, "keys.json"), "utf8");
  assert.ok(!stored.includes(key), "keys.json holds no clear key");
  const entry = JSON.parse(stored).find((k) => k.name === "laptop");
  assert.equal(entry.sha256, crypto.createHash("sha256").update(key).digest("hex"));
  assert.equal(entry.mode, "read");

  const client = await mcpClient(key);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6);
  await client.close();

  assert.equal((await post("/admin/keys/laptop/revoke", {})).status, 403, "revoke needs the form token");
  const rev = await post("/admin/keys/laptop/revoke", { csrf });
  assert.equal(rev.status, 303);
  const after = await postMcp({ Authorization: `Bearer ${key}` });
  assert.equal(after.status, 401, "revoked key no longer works");
});

test("OAuth: state carries a nonce, include_granted_scopes=false, redirect from PUBLIC_URL; bad nonce -> 400", async () => {
  const r = await fetch(`${base}/auth/aroncorp`, { headers: ADMIN, redirect: "manual" });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.hostname, "accounts.google.com");
  const state = loc.searchParams.get("state");
  assert.match(state, /^aroncorp\.[A-Za-z0-9_-]{16,}$/);
  assert.equal(loc.searchParams.get("include_granted_scopes"), "false");
  assert.equal(loc.searchParams.get("redirect_uri"), "https://hub.example.test/oauth2callback");
  assert.equal(loc.searchParams.get("client_id"), "123456789012-fake.apps.googleusercontent.com");

  const r2 = await fetch(`${base}/auth/aroncorp`, { headers: ADMIN, redirect: "manual" });
  assert.notEqual(new URL(r2.headers.get("location")).searchParams.get("state"), state, "fresh nonce each time");

  assert.equal((await fetch(`${base}/auth/inteliclic`, { headers: ADMIN, redirect: "manual" })).status, 404, "unserved");

  for (const s of ["aroncorp.unknownnonce", "aroncorp", "personal." + state.split(".")[1]]) {
    const cb = await fetch(`${base}/oauth2callback?code=x&state=${encodeURIComponent(s)}`, { headers: ADMIN });
    assert.equal(cb.status, 400, s);
  }

  const err = await fetch(`${base}/oauth2callback?error=access_denied&state=${encodeURIComponent(state)}`, { headers: ADMIN });
  assert.equal(err.status, 400);
  assert.match(await err.text(), /access_denied/);
  const authLog = fs.readFileSync(path.join(dataDir, "log", "auth.jsonl"), "utf8");
  assert.match(authLog, /"error":"access_denied"/);
});

test("stdio registration still registers all 9 tools", async () => {
  const listNames = async (opts) => {
    const server = new McpServer({ name: "t", version: "1" });
    registerTools(server, opts);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools;
  };
  const all = await listNames();
  assert.equal(all.length, 9);
  assert.deepEqual(all.map((t) => t.name).sort(), [...ALL_TOOLS].sort());
  const accountKeys = JSON.parse(fs.readFileSync(new URL("../accounts.json", import.meta.url), "utf8")).map((a) => a.key);
  assert.deepEqual(all.find((t) => t.name === "gmail_search").inputSchema.properties.account.enum, accountKeys);
  const read = await listNames({ tools: READ_TOOLS, accountKeys: ["personal"] });
  assert.equal(read.length, 6);
});
