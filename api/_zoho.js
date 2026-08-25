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

let cachedToken = null, tokenExpiry = 0, inflight = null, lastMint = 0;

/* ── Shared token store (optional) ─────────────────────────────────────────────────────────
   Each Vercel API route is its OWN lambda with its own memory, so every cold start used to
   mint another access token. Zoho caps both the number of live tokens per refresh token (the
   oldest get invalidated → INVALID_TOKEN) and how fast you may mint them (→ "Access Denied").
   One row in Supabase gives the whole fleet a single token, which removes both limits as a
   concern.

   Needs the table below; until it exists this degrades silently to per-instance caching, which
   still works — it just mints more often.

     create table if not exists public.zoho_token (
       id smallint primary key default 1,
       access_token text not null,
       expires_at timestamptz not null,
       updated_at timestamptz not null default now(),
       constraint zoho_token_singleton check (id = 1));
     alter table public.zoho_token enable row level security;
     revoke all on public.zoho_token from anon, authenticated;

   RLS on with NO policies, so the browser's publishable key can neither read nor write it.
   Only the service_role key (server-side only) bypasses RLS. */
const SB_URL = process.env.SUPABASE_URL || "https://lmlixmzmzpzgeggvywwb.supabase.co";
const SB_SERVICE = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "").trim();
let sharedOff = 0; // epoch ms until which we stop trying (table missing / not permitted)
const sharedUsable = () => !!SB_SERVICE && Date.now() > sharedOff;
const sbHeaders = () => ({ apikey: SB_SERVICE, Authorization: "Bearer " + SB_SERVICE, "Content-Type": "application/json" });

async function sharedRead() {
  if (!sharedUsable()) return null;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/zoho_token?id=eq.1&select=access_token,expires_at`, { headers: sbHeaders() });
    if (!r.ok) { sharedOff = Date.now() + 10 * 60 * 1000; return null; } // e.g. table not created yet
    const rows = await r.json();
    const row = Array.isArray(rows) && rows[0];
    if (!row || !row.access_token) return null;
    const exp = Date.parse(row.expires_at);
    // 120s of headroom so we never hand out a token about to die mid-request.
    return (isFinite(exp) && exp > Date.now() + 120000) ? { token: row.access_token, exp } : null;
  } catch (e) { return null; }
}
async function sharedWrite(token, exp) {
  if (!sharedUsable()) return;
  try {
    await fetch(`${SB_URL}/rest/v1/zoho_token?on_conflict=id`, {
      method: "POST",
      headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: 1, access_token: token, expires_at: new Date(exp).toISOString(), updated_at: new Date().toISOString() }),
    });
  } catch (e) { /* the shared store is an optimisation; never fail a request over it */ }
}
// A 401 storm (several routes waking at once) must not turn into a refresh storm. One forced
// mint per instance per MIN_MINT_MS; inside that window a caller reuses the token we just got,
// which is almost certainly the fresh one anyway.
const MIN_MINT_MS = 10000;

/** @param force  true = ignore the cache and mint a fresh token (use after a 401). */
/**
 * @param force  true after a 401 — do not trust our own cache.
 * @param stale  the token that just failed, so a shared row still holding it is skipped.
 */
export async function getZohoToken(force, stale) {
  if (!force && cachedToken && Date.now() < tokenExpiry) return cachedToken;
  // Throttle forced mints: if we minted moments ago, that token IS the fresh one.
  if (force && cachedToken && cachedToken !== stale && (Date.now() - lastMint) < MIN_MINT_MS) return cachedToken;

  // Another lambda may already have minted one — far cheaper than minting our own, and it keeps
  // the fleet on a single token.
  const shared = await sharedRead();
  if (shared && shared.token !== stale) {
    cachedToken = shared.token; tokenExpiry = shared.exp - 60000;
    return cachedToken;
  }
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
      if (!data.access_token) {
        // Zoho rate-limits the refresh endpoint ("Access Denied" under a burst). Minting LESS
        // often is the fix, not more — but if we are already holding a token that has not
        // expired, keep using it rather than failing the request outright.
        if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
        throw new Error(`token refresh failed: ${data.error || JSON.stringify(data)}`);
      }
      cachedToken = data.access_token;
      // Hold it nearly the full hour. Refreshing early was making things WORSE: every extra
      // mint both invalidates an older token and counts against Zoho's refresh rate limit.
      const ttl = Math.min(Number(data.expires_in) || 3600, 3600);
      tokenExpiry = Date.now() + Math.max(60, ttl - 60) * 1000;
      lastMint = Date.now();
      await sharedWrite(cachedToken, tokenExpiry);   // so the other routes reuse this one
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
    const fresh = await getZohoToken(true, token); // pass the failed token so it is not handed back
    if (fresh !== token) res = await run(fresh);
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

/** Non-secret snapshot of this lambda's token state, for /api/zoho-health. */
export function zohoTokenState() {
  return {
    hasCreds: hasZohoCreds(),
    cached: !!cachedToken,
    validForSec: cachedToken ? Math.max(0, Math.round((tokenExpiry - Date.now()) / 1000)) : 0,
    secSinceMint: lastMint ? Math.round((Date.now() - lastMint) / 1000) : null,
    sharedStore: !SB_SERVICE ? "no-service-key" : (Date.now() > sharedOff ? "enabled" : "unavailable (table missing?)"),
  };
}
