// /api/_zoho.js — one Zoho token manager with automatic recovery from INVALID_TOKEN.
//
// THE BUG THIS FIXES
// Zoho allows only a limited number of live access tokens per refresh token, and mints a new one
// each time any lambda refreshes — which silently invalidates the OLDEST outstanding token. Every
// route here kept its own module-scoped cache with a ~1 hour TTL, so a lambda whose token had been
// invalidated elsewhere kept presenting it until its own timer expired. Result: "invalid oauth
// token" 401s on some endpoints while others worked fine, with the same credentials, at the same
// moment. Nothing was actually wrong with the refresh token.
//
// THE FIX: treat a 401 as "my cached token is stale", force a fresh one, and retry once. That is
// what zoho-ready.js already did — and it was the one endpoint that never broke.
//
// Underscore prefix keeps Vercel from routing this as an endpoint.

const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
export const ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
export const ZOHO_API_VERSION = process.env.ZOHO_API_VERSION || "v8";

export function hasZohoCreds() {
  return !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN);
}

let cachedToken = null, tokenExpiry = 0, inflight = null;

/** @param force  true = ignore the cache and mint a fresh token (use after a 401). */
export async function getZohoToken(force) {
  if (!force && cachedToken && Date.now() < tokenExpiry) return cachedToken;
  // Single-flight: a burst of parallel calls must not each mint a token — every extra token
  // invalidates an older one and makes the very problem this file exists to fix more likely.
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        }),
      });
      const data = await res.json();
      if (!data.access_token) throw new Error(`token refresh failed: ${data.error || JSON.stringify(data)}`);
      cachedToken = data.access_token;
      // Deliberately short next to Zoho's 3600s: re-minting early is cheap, and a token we keep
      // too long is exactly what goes stale underneath us.
      const ttl = Math.min(Number(data.expires_in) || 3600, 3600);
      tokenExpiry = Date.now() + Math.max(60, ttl - 300) * 1000;
      return cachedToken;
    } finally { inflight = null; }
  })();
  return inflight;
}

const isTokenError = (status, body) =>
  status === 401 || (status === 400 && /INVALID_TOKEN|invalid oauth token/i.test(String(body || "")));

/**
 * fetch() against Zoho with the Authorization header applied, retrying ONCE with a fresh token
 * when Zoho says the token is invalid. Returns a normal Response. The body is read once here to
 * inspect it, so a `.text` string is attached for callers that want it without re-reading.
 */
export async function zohoFetch(url, init) {
  const opts = init || {};
  const run = async (token) => fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Zoho-oauthtoken ${token}` },
  });

  let token = await getZohoToken(false);
  let res = await run(token);
  if (res.status === 204) return res;

  if (isTokenError(res.status)) {
    token = await getZohoToken(true);   // stale cache → mint a fresh one and try again
    res = await run(token);
  }
  return res;
}

/** zohoFetch + JSON, with the raw text kept for error reporting. Never throws on a bad body. */
export async function zohoJson(url, init) {
  const res = await zohoFetch(url, init);
  if (res.status === 204) return { res, ok: true, status: 204, data: {}, text: "" };
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = null; }
  return { res, ok: res.ok, status: res.status, data: data || {}, text };
}
