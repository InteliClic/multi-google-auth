import express from "express";
import { PORT, PUBLIC_URL } from "./config.js";
import { authUrl, exchangeCode } from "./auth.js";
import { accounts, listAccounts } from "./tools.js";
import { issueState, consumeState, keyFromState } from "./oauthState.js";
import { esc } from "./html.js";

// The status page (/), /auth/:key and /oauth2callback. Shared by the stdio/--auth-only
// web server and by hub mode (--http), which mounts them behind its admin gate.
//   only:                 account keys to show and allow (default: all)
//   includeGrantedScopes: passed to Google's consent URL (hub mode: false)
//   onAuthError(info):    extra sink for Google's ?error=... (hub mode: log/auth.jsonl)
export function mountAuthRoutes(app, { only = null, includeGrantedScopes = true, onAuthError = null } = {}) {
  const allowed = (key) => accounts.find((x) => x.key === key && (!only || only.includes(key)));

  app.get("/", async (_req, res) => {
    const rows = await listAccounts({ probe: true, only });
    const li = rows
      .map((r) => {
        const state = r.live ? "🟢 live" : r.has_token ? "🔴 broken" : "⚪ not connected";
        return `<li style="margin:.5em 0"><b>${esc(r.account)}</b> (${esc(r.expected_email)}) — ${state}` +
          ` <small style="color:#888">· ${esc(r.client)}</small>` +
          (r.authorized_email ? `<br><small>authorized as ${esc(r.authorized_email)}</small>` : "") +
          ` &nbsp; <a href="/auth/${encodeURIComponent(r.account)}">authorize / re-authorize</a></li>`;
      })
      .join("");
    res.send(
      `<html><body style="font-family:system-ui;max-width:640px;margin:40px auto">` +
        `<h2>multi-google-auth</h2><ul style="list-style:none;padding:0">${li}</ul></body></html>`
    );
  });

  app.get("/auth/:key", (req, res) => {
    const a = allowed(req.params.key);
    if (!a) return res.status(404).type("text/plain").send(`Unknown account "${req.params.key}"`);
    res.redirect(authUrl(a.key, a.email, { state: issueState(a.key), includeGrantedScopes }));
  });

  app.get("/oauth2callback", async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
      const info = { at: new Date().toISOString(), error: String(error).slice(0, 200), state_key: keyFromState(state) };
      console.error(`[auth] Google returned error=${info.error} for state key "${info.state_key}"`);
      try {
        onAuthError?.(info);
      } catch {
        /* logging must not fail the page */
      }
      return res.status(400).send(`<html><body style="font-family:system-ui;max-width:640px;margin:40px auto">` +
        `<h2>OAuth error</h2><p>Google returned <code>${esc(info.error)}</code>.</p><p><a href="/">← back</a></p></body></html>`);
    }
    if (!code || !state) return res.status(400).type("text/plain").send("Missing code/state");
    const key = consumeState(state);
    if (!key) return res.status(400).type("text/plain").send("Unknown, used or expired state. Start again from /auth/<account>.");
    try {
      const a = allowed(key);
      if (!a) return res.status(400).type("text/plain").send("Unknown account in state");
      const { authorized_email } = await exchangeCode(a.key, String(code));
      const mismatch =
        authorized_email && a.email && authorized_email.toLowerCase() !== a.email.toLowerCase();
      res.send(
        `<html><body style="font-family:system-ui;max-width:640px;margin:40px auto">` +
          `<h2>✅ Authorized: ${esc(a.key)}</h2>` +
          `<p>Signed in as <b>${esc(authorized_email || "unknown")}</b>.</p>` +
          (mismatch
            ? `<p style="color:#b00">⚠️ Expected ${esc(a.email)} but you authorized ${esc(authorized_email)}. Re-run and pick the right account.</p>`
            : "") +
          `<p><a href="/">← back</a></p></body></html>`
      );
    } catch (e) {
      res.status(500).type("text/plain").send(`Token exchange failed: ${e.message}`);
    }
  });
}

export function startAuthServer() {
  const app = express();
  mountAuthRoutes(app);

  return new Promise((resolve, reject) => {
    const server = app.listen(PORT);
    server.once("listening", () => {
      console.error(`[auth] server on ${PUBLIC_URL}  (open it to authorize accounts)`);
      resolve(server);
    });
    server.once("error", (err) => {
      // Without this handler a busy port is an *uncaught* exception that kills the
      // whole process -- e.g. Claude launching the MCP while `npm run auth` runs.
      if (err.code === "EADDRINUSE") {
        const e = new Error(
          `port ${PORT} is already in use -- another multi-google-auth instance is probably serving ${PUBLIC_URL} already. ` +
            "Open that, or set PORT=<other> / DISABLE_AUTH_SERVER=1."
        );
        e.code = "EADDRINUSE";
        return reject(e);
      }
      reject(err);
    });
  });
}
