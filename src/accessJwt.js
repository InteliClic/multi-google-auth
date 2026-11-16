// Verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion header, or the
// CF_Authorization cookie) with node:crypto only. Any doubt means "no": a failed
// JWKS fetch, an unknown key id, a bad claim -- each returns { ok: false, reason }.
// The reason is for stderr only; callers answer a plain 403.
import crypto from "node:crypto";

const LEEWAY_S = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;
const MIN_REFETCH_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export function normalizeTeamDomain(v) {
  return String(v || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

async function defaultFetchJwks(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!res.ok) throw new Error(`JWKS fetch answered HTTP ${res.status}`);
  return res.json();
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

// The token a request carries: the header first, then the CF_Authorization cookie.
export function tokenFromRequest(req) {
  const h = req.get("cf-access-jwt-assertion");
  if (h) return h.trim();
  const cookie = req.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === "CF_Authorization") return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

//   teamDomain: e.g. yourteam.cloudflareaccess.com
//   auds:       accepted Access application AUD tags
//   adminEmails: lower-cased emails allowed in
//   fetchJwks(url): returns the parsed JWKS ({ keys: [...] }); injectable for tests
//   now():      ms clock; injectable for tests
export function createAccessVerifier({ teamDomain, auds, adminEmails, fetchJwks = defaultFetchJwks, now = Date.now }) {
  const domain = normalizeTeamDomain(teamDomain);
  const issuer = `https://${domain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  let keys = null; // Map kid -> KeyObject
  let fetchedAt = 0;
  let lastAttempt = -Infinity;
  let inflight = null;

  async function refresh() {
    if (inflight) return inflight;
    if (now() - lastAttempt < MIN_REFETCH_MS) return false; // at most one fetch a minute
    lastAttempt = now();
    inflight = (async () => {
      try {
        const jwks = await fetchJwks(certsUrl);
        const map = new Map();
        for (const jwk of Array.isArray(jwks?.keys) ? jwks.keys : []) {
          if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string") continue;
          try {
            map.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
          } catch {
            /* skip a malformed key */
          }
        }
        keys = map;
        fetchedAt = now();
        return true;
      } catch (e) {
        throw new Error(`JWKS fetch failed: ${e?.message || e}`);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function keyFor(kid) {
    if (!keys || now() - fetchedAt > JWKS_TTL_MS) await refresh();
    if (keys?.has(kid)) return keys.get(kid);
    // Unknown kid: Cloudflare may have rotated its keys. Refetch (rate-limited) once.
    await refresh();
    return keys?.get(kid) || null;
  }

  async function verify(token) {
    try {
      if (!token) return { ok: false, reason: "no Access token" };
      const parts = String(token).split(".");
      if (parts.length !== 3) return { ok: false, reason: "malformed token" };
      let header, payload;
      try {
        header = b64urlJson(parts[0]);
        payload = b64urlJson(parts[1]);
      } catch {
        return { ok: false, reason: "malformed token" };
      }
      if (header?.alg !== "RS256") return { ok: false, reason: `alg ${header?.alg} is not RS256` };
      if (typeof header.kid !== "string") return { ok: false, reason: "no kid" };
      const key = await keyFor(header.kid);
      if (!key) return { ok: false, reason: `unknown kid ${header.kid}` };
      const signed = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
      const sig = Buffer.from(parts[2], "base64url");
      if (!crypto.verify("RSA-SHA256", signed, key, sig)) return { ok: false, reason: "bad signature" };

      if (payload.iss !== issuer) return { ok: false, reason: `iss ${payload.iss} is not ${issuer}` };
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.some((a) => typeof a === "string" && auds.includes(a))) return { ok: false, reason: "aud not accepted" };
      const t = now() / 1000;
      if (typeof payload.exp !== "number" || payload.exp <= t - LEEWAY_S) return { ok: false, reason: "expired" };
      if (typeof payload.nbf === "number" && payload.nbf > t + LEEWAY_S) return { ok: false, reason: "nbf in the future" };
      if (typeof payload.iat === "number" && payload.iat > t + LEEWAY_S) return { ok: false, reason: "iat in the future" };
      const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
      if (!email || !adminEmails.includes(email)) return { ok: false, reason: `email ${email || "(none)"} not in HUB_ADMIN_EMAILS` };
      return { ok: true, email };
    } catch (e) {
      return { ok: false, reason: e?.message || String(e) };
    }
  }

  return { verify, issuer, certsUrl };
}
