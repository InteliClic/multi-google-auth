import { google } from "googleapis";
import { clientFor, REDIRECT_URI, SCOPES } from "./config.js";
import { loadToken, saveToken } from "./tokenStore.js";

// One OAuth2 client per account: normally the shared GOOGLE_CLIENT_ID, but an
// account can point at its own client via GOOGLE_CLIENT_ID_<KEY> (see config.js).
export function makeOAuthClient(key) {
  const { id, secret } = clientFor(key);
  return new google.auth.OAuth2(id, secret, REDIRECT_URI);
}

// Build the Google consent URL for an account.
// access_type=offline + prompt=consent GUARANTEE a refresh_token is returned
// every time -- without prompt=consent Google omits it on repeat authorizations,
// which is how accounts end up "connected" but unable to refresh.
export function authUrl(key, email) {
  return makeOAuthClient(key).generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: SCOPES,
    state: key,
    login_hint: email || undefined,
  });
}

export async function exchangeCode(key, code) {
  const c = makeOAuthClient(key);
  const { tokens } = await c.getToken(code);
  c.setCredentials(tokens);

  let authorized_email = null;
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: c });
    const me = await oauth2.userinfo.get();
    authorized_email = me.data.email || null;
  } catch {
    /* non-fatal */
  }

  // Preserve an existing refresh_token if Google didn't send a fresh one.
  const existing = loadToken(key);
  if (!tokens.refresh_token && existing?.tokens?.refresh_token) {
    tokens.refresh_token = existing.tokens.refresh_token;
  }

  saveToken(key, { authorized_email, client_id: clientFor(key).id, saved_at: new Date().toISOString(), tokens });
  return { authorized_email, tokens };
}

// An authorized OAuth2 client that auto-refreshes and persists new tokens.
export function authorizedClient(key) {
  const stored = loadToken(key);
  if (!stored || !stored.tokens || !stored.tokens.refresh_token) {
    const err = new Error(`Account "${key}" is not authorized. Run /auth/${key}`);
    err.code = "NO_TOKEN";
    throw err;
  }
  const c = makeOAuthClient(key);
  c.setCredentials(stored.tokens);
  c.on("tokens", (t) => {
    const cur = loadToken(key) || { tokens: {} };
    const merged = { ...cur.tokens, ...t };
    if (!merged.refresh_token && cur.tokens.refresh_token) {
      merged.refresh_token = cur.tokens.refresh_token;
    }
    saveToken(key, { ...cur, tokens: merged, saved_at: new Date().toISOString() });
  });
  return c;
}

// Actively test whether the stored refresh token still works. This is what makes
// list_accounts honest: a token file can exist while Google has revoked/expired
// the grant. getAccessToken() forces a refresh and surfaces invalid_grant.
export async function probe(key) {
  try {
    const c = authorizedClient(key);
    const res = await c.getAccessToken();
    return { live: !!res.token };
  } catch (e) {
    const msg = String(e?.message || e);
    const revoked = /invalid_grant/.test(msg);
    return { live: false, error: revoked ? "token expired or revoked" : msg };
  }
}
