import express from "express";
import { PORT, PUBLIC_URL } from "./config.js";
import { authUrl, exchangeCode } from "./auth.js";
import { accounts, listAccounts } from "./tools.js";

export function startAuthServer() {
  const app = express();

  app.get("/", async (_req, res) => {
    const rows = await listAccounts({ probe: true });
    const li = rows
      .map((r) => {
        const state = r.live ? "🟢 live" : r.has_token ? "🔴 broken" : "⚪ not connected";
        return `<li style="margin:.5em 0"><b>${r.account}</b> (${r.expected_email}) — ${state}` +
          ` <small style="color:#888">· ${r.client}</small>` +
          (r.authorized_email ? `<br><small>authorized as ${r.authorized_email}</small>` : "") +
          ` &nbsp; <a href="/auth/${r.account}">authorize / re-authorize</a></li>`;
      })
      .join("");
    res.send(
      `<html><body style="font-family:system-ui;max-width:640px;margin:40px auto">` +
        `<h2>multi-google-auth</h2><ul style="list-style:none;padding:0">${li}</ul></body></html>`
    );
  });

  app.get("/auth/:key", (req, res) => {
    const a = accounts.find((x) => x.key === req.params.key);
    if (!a) return res.status(404).send(`Unknown account "${req.params.key}"`);
    res.redirect(authUrl(a.key, a.email));
  });

  app.get("/oauth2callback", async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code || !state) return res.status(400).send("Missing code/state");
    try {
      const a = accounts.find((x) => x.key === state);
      if (!a) return res.status(400).send(`Unknown state "${state}"`);
      const { authorized_email } = await exchangeCode(a.key, String(code));
      const mismatch =
        authorized_email && a.email && authorized_email.toLowerCase() !== a.email.toLowerCase();
      res.send(
        `<html><body style="font-family:system-ui;max-width:640px;margin:40px auto">` +
          `<h2>✅ Authorized: ${a.key}</h2>` +
          `<p>Signed in as <b>${authorized_email || "unknown"}</b>.</p>` +
          (mismatch
            ? `<p style="color:#b00">⚠️ Expected ${a.email} but you authorized ${authorized_email}. Re-run and pick the right account.</p>`
            : "") +
          `<p><a href="/">← back</a></p></body></html>`
      );
    } catch (e) {
      res.status(500).send(`Token exchange failed: ${e.message}`);
    }
  });

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
