import crypto from "node:crypto";

// OAuth `state` = "<account key>.<random nonce>". The nonce is remembered in memory
// for 10 minutes and can be used once, so a callback cannot be replayed or forged
// by someone who only knows an account key. Account keys never contain ".", so the
// key is everything before the last ".".
const TTL_MS = 10 * 60 * 1000;
const nonces = new Map(); // nonce -> { key, expires }

function sweep(now) {
  for (const [n, v] of nonces) if (v.expires <= now) nonces.delete(n);
}

export function issueState(key) {
  const now = Date.now();
  sweep(now);
  const nonce = crypto.randomBytes(16).toString("base64url");
  nonces.set(nonce, { key, expires: now + TTL_MS });
  return `${key}.${nonce}`;
}

// The account key the state names, without checking the nonce.
export function keyFromState(state) {
  const s = String(state || "");
  const i = s.lastIndexOf(".");
  return i > 0 ? s.slice(0, i) : s;
}

// Returns the account key when the nonce is known, unused and unexpired; else null.
// A nonce is deleted on first use, whatever the outcome.
export function consumeState(state) {
  const s = String(state || "");
  const i = s.lastIndexOf(".");
  if (i <= 0) return null;
  const key = s.slice(0, i);
  const nonce = s.slice(i + 1);
  const entry = nonces.get(nonce);
  if (!entry) return null;
  nonces.delete(nonce);
  if (entry.expires <= Date.now() || entry.key !== key) return null;
  return key;
}
