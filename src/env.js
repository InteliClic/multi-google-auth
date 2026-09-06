// Load .env from the repo root (next to package.json) no matter what the current
// working directory is. MCP hosts (Claude Code, Claude Desktop) launch this server
// with THEIR cwd, so a cwd-relative `.env` would silently not be found and the
// server would die with "Missing required env". DOTENV_CONFIG_PATH still wins.
// `quiet` keeps dotenv from ever printing to stdout, which is reserved for MCP.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH || path.join(here, "..", ".env"),
  quiet: true,
});
