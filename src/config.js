import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

// OAuth scopes. gmail.modify = read + create drafts + label (never sends on its
// own here). calendar = read/write events. drive.readonly = search/read only.
// userinfo.email lets us verify which account actually authorized.
export const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.readonly",
];

export const PORT = Number(process.env.PORT || 8790);
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
export const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || `${PUBLIC_URL}/oauth2callback`;

export const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
export const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

// Per-account override: GOOGLE_CLIENT_ID_<KEY> / GOOGLE_CLIENT_SECRET_<KEY>, where
// <KEY> is the accounts.json key upper-cased (non-alphanumerics -> "_"). Lets one
// account use a different OAuth client -- e.g. a consumer @gmail.com account on a
// separate project that stays in "Testing" (consumer accounts cannot grant
// restricted Gmail/Drive scopes to an unverified production app), while the
// Workspace accounts keep using the production client.
export function suffixOf(key) {
  return String(key || "").toUpperCase().replace(/[^A-Z0-9]/g, "_");
}
export function clientFor(key) {
  const s = suffixOf(key);
  const id = process.env[`GOOGLE_CLIENT_ID_${s}`];
  const secret = process.env[`GOOGLE_CLIENT_SECRET_${s}`];
  if (id && secret) return { id, secret, source: `GOOGLE_CLIENT_ID_${s}` };
  return { id: CLIENT_ID, secret: CLIENT_SECRET, source: "GOOGLE_CLIENT_ID" };
}

export const TOKENS_DIR = process.env.TOKENS_DIR
  ? path.resolve(process.env.TOKENS_DIR)
  : path.join(ROOT, "tokens");

export function loadAccounts() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "accounts.json"), "utf8"));
  return raw.map((a) => ({ key: a.key, email: a.email, label: a.label || a.key }));
}

export function requireConfig() {
  const accounts = loadAccounts();
  const half = accounts
    .map((a) => a.key)
    .filter((k) => {
      const s = suffixOf(k);
      return !!process.env[`GOOGLE_CLIENT_ID_${s}`] !== !!process.env[`GOOGLE_CLIENT_SECRET_${s}`];
    });
  if (half.length) {
    throw new Error(
      `Set BOTH GOOGLE_CLIENT_ID_<KEY> and GOOGLE_CLIENT_SECRET_<KEY> for account(s): ${half.join(", ")}`
    );
  }
  const uncovered = accounts.filter((a) => {
    const c = clientFor(a.key);
    return !c.id || !c.secret;
  });
  if (!uncovered.length) return;
  const anyOverride = accounts.some((a) => clientFor(a.key).source !== "GOOGLE_CLIENT_ID");
  if (!CLIENT_ID && !CLIENT_SECRET && !anyOverride) {
    throw new Error(
      "Missing required env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. Copy .env.example to .env and fill it in."
    );
  }
  throw new Error(
    `No OAuth client credentials for account(s): ${uncovered.map((a) => a.key).join(", ")}. ` +
      "Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env, or GOOGLE_CLIENT_ID_<KEY> / GOOGLE_CLIENT_SECRET_<KEY> per account."
  );
}
