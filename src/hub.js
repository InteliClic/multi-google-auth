// Hub mode (`node src/index.js --http`): the connector as an always-on web service
// behind a Cloudflare Tunnel. Plain HTTP on localhost; the tunnel terminates TLS.
// Read-only MCP over Streamable HTTP (stateless) for callers holding a hub key, plus
// the admin and sign-in pages behind Cloudflare Access. Assume it is found by
// attackers on day one: every route except /health needs a key or an admin identity.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ROOT, PUBLIC_URL, loadAccounts, setTokensDir } from "./config.js";
import { registerTools, READ_TOOLS } from "./mcp.js";
import { mountAuthRoutes } from "./authServer.js";
import { probe } from "./auth.js";
import { hasToken } from "./tokenStore.js";
import { esc, page } from "./html.js";

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_MS = 10 * 60 * 1000;
const LAST_USED_EVERY_MS = 60 * 1000;
const KEY_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const sha256hex = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

function safeEqualStr(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Resolve options (explicit option > env > default) and validate them.
export function hubConfig(options = {}) {
  const env = process.env;
  const known = loadAccounts().map((a) => a.key);
  const served = options.accounts ? [...options.accounts] : list(env.HUB_ACCOUNTS);
  if (!served.length) {
    throw new Error(
      "HUB_ACCOUNTS is required in hub mode: a comma-separated list of the accounts.json keys this hub serves (e.g. HUB_ACCOUNTS=personal,personal-drive)."
    );
  }
  const unknown = served.filter((k) => !known.includes(k));
  if (unknown.length) {
    throw new Error(`HUB_ACCOUNTS names key(s) not in accounts.json: ${unknown.join(", ")}. Known: ${known.join(", ")}`);
  }
  const dataDir = path.resolve(options.dataDir ?? (env.HUB_DATA_DIR || path.join(ROOT, "data")));
  const port = Number(options.port ?? (env.HUB_PORT !== undefined && env.HUB_PORT !== "" ? env.HUB_PORT : 8790));
  return {
    served,
    dataDir,
    port,
    bind: options.bind ?? (env.HUB_BIND || "127.0.0.1"),
    adminEmails: (options.adminEmails ?? list(env.HUB_ADMIN_EMAILS)).map((e) => e.toLowerCase()),
    devNoAccess: options.devNoAccess ?? env.HUB_DEV_NO_ACCESS === "1",
    probeMinutes: Number(options.probeMinutes ?? (env.HUB_PROBE_MINUTES || 15)),
    firstProbeMs: Number(options.firstProbeMs ?? 5000),
    tokensDir: env.TOKENS_DIR ? null : path.join(dataDir, "tokens"),
  };
}

export async function startHub(options = {}) {
  const cfg = hubConfig(options);
  const { served, dataDir } = cfg;
  const logDir = path.join(dataDir, "log");
  fs.mkdirSync(logDir, { recursive: true });
  if (cfg.tokensDir) {
    fs.mkdirSync(cfg.tokensDir, { recursive: true });
    setTokensDir(cfg.tokensDir);
  }
  const keysFile = path.join(dataDir, "keys.json");
  const callsLog = path.join(logDir, "calls.jsonl");
  const authLog = path.join(logDir, "auth.jsonl");
  const accountsById = Object.fromEntries(loadAccounts().map((a) => [a.key, a]));
  const csrfToken = crypto.randomBytes(32).toString("hex");
  const publicOrigin = (() => {
    try {
      return new URL(PUBLIC_URL).origin;
    } catch {
      return null;
    }
  })();

  // ---- caller keys (only their SHA-256 is stored) ----
  function loadKeys() {
    try {
      const v = JSON.parse(fs.readFileSync(keysFile, "utf8"));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  const saveKeys = (keys) => writeJsonAtomic(keysFile, keys);

  // Compare the presented key's digest against every stored digest, without an early exit.
  function findKey(presented) {
    if (!presented) return null;
    const digest = crypto.createHash("sha256").update(presented, "utf8").digest();
    let hit = null;
    for (const k of loadKeys()) {
      let stored;
      try {
        stored = Buffer.from(String(k.sha256 || ""), "hex");
      } catch {
        continue;
      }
      if (stored.length === digest.length && crypto.timingSafeEqual(stored, digest) && !hit) hit = k;
    }
    return hit;
  }

  const lastUsedWritten = new Map();
  function touchKey(name) {
    const now = Date.now();
    if (now - (lastUsedWritten.get(name) || 0) < LAST_USED_EVERY_MS) return;
    lastUsedWritten.set(name, now);
    try {
      const keys = loadKeys();
      const k = keys.find((x) => x.name === name);
      if (!k) return;
      k.last_used_at = new Date(now).toISOString();
      saveKeys(keys);
    } catch (e) {
      console.error(`[hub] could not update last_used_at: ${e.message}`);
    }
  }

  // ---- failed-key throttle (in memory) ----
  const fails = new Map(); // ip -> { times: [ms], blockedUntil: ms }
  const clientIp = (req) => req.get("cf-connecting-ip") || req.socket.remoteAddress || "unknown";
  function isBlocked(ip, now) {
    const f = fails.get(ip);
    return !!(f && f.blockedUntil > now);
  }
  function noteFailure(ip, now) {
    const f = fails.get(ip) || { times: [], blockedUntil: 0 };
    f.times = f.times.filter((t) => now - t < FAIL_WINDOW_MS);
    f.times.push(now);
    if (f.times.length >= FAIL_LIMIT) {
      f.blockedUntil = now + BLOCK_MS;
      f.times = [];
    }
    fails.set(ip, f);
    if (fails.size > 10000) {
      for (const [k, v] of fails) if (v.blockedUntil <= now && !v.times.some((t) => now - t < FAIL_WINDOW_MS)) fails.delete(k);
    }
  }

  // ---- logs (a logging failure never fails the call) ----
  function appendJsonl(file, obj) {
    try {
      fs.appendFileSync(file, JSON.stringify(obj) + "\n");
    } catch (e) {
      console.error(`[hub] log write failed (${path.basename(file)}): ${e.message}`);
    }
  }
  function summarizeArgs(args = {}) {
    const out = {};
    if (typeof args.query === "string") out.query = args.query.slice(0, 80);
    for (const k of ["thread_id", "file_id", "calendar_id", "max_results", "time_min", "time_max", "probe"]) {
      if (args[k] !== undefined) out[k] = typeof args[k] === "string" ? args[k].slice(0, 200) : args[k];
    }
    return out;
  }
  function countItems(r) {
    if (Array.isArray(r)) return r.length;
    for (const k of ["threads", "messages", "events", "files"]) if (Array.isArray(r?.[k])) return r[k].length;
    if (typeof r?.content === "string") return 1;
    return null;
  }

  // ---- health probe on a timer, never per request ----
  const health = { live: null, last_probe_at: null, byKey: {} };
  let probing = false;
  async function runProbe() {
    if (probing) return;
    probing = true;
    try {
      const byKey = {};
      let live = 0;
      for (const key of served) {
        try {
          if (!hasToken(key)) {
            byKey[key] = "not connected";
            continue;
          }
          const p = await probe(key);
          byKey[key] = p.live ? "live" : "broken";
          if (p.live) live++;
        } catch {
          byKey[key] = "broken";
        }
      }
      health.byKey = byKey;
      health.live = live;
      health.last_probe_at = new Date().toISOString();
    } catch (e) {
      console.error(`[hub] probe failed: ${e?.message || e}`);
    } finally {
      probing = false;
    }
  }
  const timers = [];
  const firstProbe = setTimeout(() => runProbe().catch(() => {}), cfg.firstProbeMs);
  firstProbe.unref();
  timers.push(firstProbe);
  if (cfg.probeMinutes > 0) {
    const every = setInterval(() => runProbe().catch(() => {}), cfg.probeMinutes * 60 * 1000);
    every.unref();
    timers.push(every);
  }

  // ---- app ----
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      accounts: served.length,
      live: health.live,
      last_probe_at: health.last_probe_at,
    });
  });

  // /mcp: caller key first, then the body (1 MB max), then a fresh stateless server.
  const rpcError = (res, status, code, message, headers = {}) => {
    res.status(status).set(headers).json({ jsonrpc: "2.0", error: { code, message }, id: null });
  };
  app.use("/mcp", (req, res, next) => {
    const now = Date.now();
    const ip = clientIp(req);
    if (isBlocked(ip, now)) {
      return rpcError(res, 429, -32029, "Too many requests", { "Retry-After": String(BLOCK_MS / 1000) });
    }
    const auth = req.get("authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const presented = (m ? m[1] : req.get("x-hub-key") || "").trim();
    const key = findKey(presented);
    if (!key) {
      noteFailure(ip, now);
      return rpcError(res, 401, -32001, "Unauthorized", { "WWW-Authenticate": "Bearer" });
    }
    req.hubKey = key;
    next();
  });
  app.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
    const keyName = req.hubKey.name;
    const server = new McpServer({ name: "multi-google-auth", version: VERSION });
    registerTools(server, {
      tools: READ_TOOLS,
      accountKeys: served,
      wrapCall: (tool, fn) => async (args = {}) => {
        const t0 = Date.now();
        const entry = { at: new Date(t0).toISOString(), key: keyName, tool, account: args.account ?? null, args: summarizeArgs(args) };
        try {
          let callArgs = args;
          if (tool === "list_accounts") callArgs = { ...args, only: served };
          else if (!served.includes(args.account)) throw new Error(`Account "${args.account}" is not served by this hub`);
          const r = await fn(callArgs);
          Object.assign(entry, { ok: true, items: countItems(r), ms: Date.now() - t0 });
          return r;
        } catch (e) {
          Object.assign(entry, { ok: false, items: null, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 200) });
          throw e;
        } finally {
          appendJsonl(callsLog, entry);
          touchKey(keyName);
        }
      },
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error(`[hub] MCP request failed: ${e?.message || e}`);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
    }
  });
  app.all("/mcp", (_req, res) => rpcError(res, 405, -32000, "Method not allowed."));
  // Body errors on /mcp (bad JSON, over 1 MB) as JSON-RPC errors.
  app.use("/mcp", (err, _req, res, _next) => {
    if (err?.type === "entity.too.large") return rpcError(res, 413, -32600, "Request body too large");
    return rpcError(res, 400, -32700, "Parse error");
  });

  // ---- admin gate: everything below needs a Cloudflare Access identity ----
  // SLICE 2 replaces this header check with verification of the Cf-Access-Jwt-Assertion
  // token (signature against the team's Access certs, audience, expiry). Until then the
  // header is trusted because the service binds to localhost and is reachable only
  // through the tunnel, where Cloudflare Access sets it.
  app.use((req, res, next) => {
    if (cfg.devNoAccess) return next();
    const email = String(req.get("cf-access-authenticated-user-email") || "").trim().toLowerCase();
    if (email && cfg.adminEmails.includes(email)) return next();
    res.status(403).type("text/plain").send("Forbidden");
  });

  mountAuthRoutes(app, {
    only: served,
    includeGrantedScopes: false,
    onAuthError: (info) => appendJsonl(authLog, info),
  });

  // Cross-site protection for the admin POSTs: a per-process token in the forms, and an
  // Origin (when the browser sends one) that must be PUBLIC_URL's.
  function csrfOk(req) {
    const origin = req.get("origin");
    if (origin && origin !== publicOrigin) return false;
    return safeEqualStr(req.body?.csrf || "", csrfToken);
  }
  const form = express.urlencoded({ extended: false, limit: "16kb" });

  function tailLines(file, n) {
    try {
      const st = fs.statSync(file);
      const max = 256 * 1024;
      const fd = fs.openSync(file, "r");
      try {
        const len = Math.min(st.size, max);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        return buf.toString("utf8").split("\n").filter(Boolean).slice(-n);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }

  app.get("/admin", (_req, res) => {
    const acctRows = served
      .map((k) => {
        const a = accountsById[k];
        const status = health.byKey[k] || (hasToken(k) ? "token present (not probed yet)" : "not connected");
        return `<tr><td><b>${esc(k)}</b></td><td>${esc(a?.label || "")}</td><td>${esc(status)}</td>` +
          `<td><a href="/auth/${encodeURIComponent(k)}">sign in / re-authorize</a></td></tr>`;
      })
      .join("");
    const keyRows = loadKeys()
      .map(
        (k) =>
          `<tr><td>${esc(k.name)}</td><td>${esc(k.mode)}</td><td>${esc(k.created_at)}</td><td>${esc(k.last_used_at || "never")}</td>` +
          `<td><form method="post" action="/admin/keys/${encodeURIComponent(k.name)}/revoke" style="margin:0">` +
          `<input type="hidden" name="csrf" value="${esc(csrfToken)}"><button type="submit">Revoke</button></form></td></tr>`
      )
      .join("");
    const logRows = tailLines(callsLog, 30)
      .reverse()
      .map((line) => {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          return "";
        }
        return `<tr><td>${esc(e.at)}</td><td>${esc(e.key)}</td><td>${esc(e.tool)}</td><td>${esc(e.account ?? "")}</td>` +
          `<td><code>${esc(JSON.stringify(e.args || {}))}</code></td><td>${e.ok ? "ok" : "error"}</td>` +
          `<td>${esc(e.items ?? "")}</td><td>${esc(e.ms)}</td><td>${esc(e.error || "")}</td></tr>`;
      })
      .join("");
    const th = (cols) => `<tr>${cols.map((c) => `<th style="text-align:left">${c}</th>`).join("")}</tr>`;
    res.set("Cache-Control", "no-store").send(
      page(
        "Hub admin",
        `<h2>multi-google-auth hub</h2>` +
          `<p>Last probe: ${esc(health.last_probe_at || "not yet")}</p>` +
          `<h3>Accounts served</h3><table cellpadding="4">${th(["Key", "Label", "Status", ""])}${acctRows}</table>` +
          `<h3>Caller keys</h3><table cellpadding="4">${th(["Name", "Mode", "Created", "Last used", ""])}${keyRows || `<tr><td colspan="5">none</td></tr>`}</table>` +
          `<h3>Create a key</h3><form method="post" action="/admin/keys">` +
          `<input type="hidden" name="csrf" value="${esc(csrfToken)}">` +
          `<label>Name <input name="name" required pattern="[A-Za-z0-9_\\-]{1,32}" maxlength="32"></label> ` +
          `<label>Mode <select name="mode"><option value="read">read</option></select></label> ` +
          `<button type="submit">Create</button></form>` +
          `<h3>Last 30 calls</h3><table cellpadding="4" style="font-size:.85em">${th(["At", "Key", "Tool", "Account", "Args", "Result", "Items", "ms", "Error"])}${logRows}</table>`
      )
    );
  });

  app.post("/admin/keys", form, (req, res) => {
    if (!csrfOk(req)) return res.status(403).type("text/plain").send("Forbidden");
    const name = String(req.body?.name || "").trim();
    const mode = String(req.body?.mode || "");
    if (!KEY_NAME_RE.test(name)) return res.status(400).type("text/plain").send("Name must be 1-32 letters, digits, - or _.");
    if (mode !== "read") return res.status(400).type("text/plain").send('Only mode "read" exists in this version.');
    const keys = loadKeys();
    if (keys.some((k) => k.name === name)) return res.status(409).type("text/plain").send("A key with that name exists.");
    const secret = crypto.randomBytes(32).toString("base64url");
    keys.push({ name, sha256: sha256hex(secret), mode, created_at: new Date().toISOString(), last_used_at: null });
    saveKeys(keys);
    console.error(`[hub] created caller key "${name}" (${mode})`);
    res.set("Cache-Control", "no-store").send(
      page(
        "Key created",
        `<h2>Key "${esc(name)}" created</h2>` +
          `<p><b>Copy it now. It is shown only once</b>; the hub keeps only its hash.</p>` +
          `<p>Header line to paste into the MCP client:</p>` +
          `<pre style="background:#f4f4f4;padding:8px;white-space:pre-wrap;word-break:break-all"><code id="header">Authorization: Bearer ${esc(secret)}</code></pre>` +
          `<p><a href="/admin">← back to admin</a></p>`
      )
    );
  });

  app.post("/admin/keys/:name/revoke", form, (req, res) => {
    if (!csrfOk(req)) return res.status(403).type("text/plain").send("Forbidden");
    const keys = loadKeys();
    const left = keys.filter((k) => k.name !== req.params.name);
    if (left.length === keys.length) return res.status(404).type("text/plain").send("No such key.");
    saveKeys(left);
    console.error(`[hub] revoked caller key "${req.params.name}"`);
    res.redirect(303, "/admin");
  });

  app.get("/approve/:id", (_req, res) => {
    res.status(501).send(page("Approvals", "<h2>Approvals are not built yet (slice 2).</h2>"));
  });

  // ---- listen ----
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(cfg.port, cfg.bind);
    s.once("listening", () => resolve(s));
    s.once("error", reject);
  });
  const port = server.address().port;
  console.error(`[hub] listening on http://${cfg.bind}:${port}  (public: ${PUBLIC_URL})`);
  console.error(`[hub] serving accounts: ${served.join(", ")}; data dir: ${dataDir}`);
  if (cfg.devNoAccess) {
    console.error("[hub] ************************************************************");
    console.error("[hub] WARNING: HUB_DEV_NO_ACCESS=1 -- the admin gate is OFF.");
    console.error("[hub] Anyone who can reach this port can open /admin and mint keys.");
    console.error("[hub] Local testing only. Never run it like this behind the tunnel.");
    console.error("[hub] ************************************************************");
  } else if (!cfg.adminEmails.length) {
    console.error("[hub] HUB_ADMIN_EMAILS is not set: admin and sign-in pages answer 403.");
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const t of timers) clearTimeout(t), clearInterval(t);
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { app, server, port, dataDir, close, runProbe };
}
