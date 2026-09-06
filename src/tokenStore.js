import fs from "node:fs";
import path from "node:path";
import { TOKENS_DIR } from "./config.js";

// Token file shape: { authorized_email, saved_at, tokens: { <google oauth2 tokens> } }

function ensureDir() {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
}
function file(key) {
  return path.join(TOKENS_DIR, `${key}.json`);
}

export function loadToken(key) {
  try {
    return JSON.parse(fs.readFileSync(file(key), "utf8"));
  } catch {
    return null;
  }
}

export function saveToken(key, data) {
  ensureDir();
  const tmp = file(key) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(key)); // atomic-ish replace
}

export function hasToken(key) {
  const t = loadToken(key);
  return !!(t && t.tokens && t.tokens.refresh_token);
}
