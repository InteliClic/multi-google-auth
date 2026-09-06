#!/usr/bin/env node
import "./env.js"; // must stay first: loads .env from the repo root before config.js reads process.env
import { requireConfig } from "./config.js";
import { startAuthServer } from "./authServer.js";
import { startMcp } from "./mcp.js";

// NOTE: this is an MCP stdio server. stdout is reserved for the MCP protocol,
// so ALL logging must go to stderr (console.error). Never console.log here.

const authOnly = process.argv.includes("--auth-only");
const disableAuthServer = process.env.DISABLE_AUTH_SERVER === "1";

async function main() {
  requireConfig();
  if (!disableAuthServer) {
    try {
      await startAuthServer(); // keeps /auth/<account> available while the MCP runs
    } catch (e) {
      // Another instance (e.g. `npm run auth`) already owns the port. Fine for the
      // MCP role -- the tools don't need the web server -- but fatal for
      // --auth-only, whose whole job IS the web server.
      if (authOnly || e.code !== "EADDRINUSE") throw e;
      console.error(`[auth] ${e.message}`);
      console.error("[auth] continuing without the auth web server (tools still work).");
    }
  }
  if (authOnly) {
    console.error("[info] --auth-only: authorize accounts in the browser, then Ctrl+C to exit.");
    return;
  }
  await startMcp();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
