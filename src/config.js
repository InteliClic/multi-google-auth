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

export const TOKENS_DIR = process.env.TOKENS_DIR
  ? path.resolve(process.env.TOKENS_DIR)
  : path.join(ROOT, "tokens");

export function loadAccounts() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "accounts.json"), "utf8"));
  return raw.map((a) => ({ key: a.key, email: a.email, label: a.label || a.key }));
}

export function requireConfig() {
  const missing = [];
  if (!CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (missing.length) {
    throw new Error(
      `Missing required env: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`
    );
  }
}
