#!/usr/bin/env node
import "dotenv/config";
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
    await startAuthServer(); // keeps /auth/<account> available while the MCP runs
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
