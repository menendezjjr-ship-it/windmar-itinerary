// /api/_lastgood.js — serve the previous good payload instead of an error.
//
// Zoho occasionally refuses a token refresh (it rate-limits them). That is transient and clears
// in under a minute, but two things turned it into a visible outage:
//   1. Cache-Control was set at the TOP of each handler, so a failed response was cached at the
//      edge for 30s and served to EVERY user — one unlucky lambda poisoned the cache for all.
//   2. The user got an error page for data we already had moments ago.
//
// So: never cache a failure, and when the live call fails, return the last successful payload
// with stale:true. A dispatch board a minute behind is worth far more than an error.
//
// Per-lambda memory. With the functions pinned to one region instances stay warm, so in practice
// the previous payload is usually right there. A genuinely cold instance has nothing to serve and
// the error still surfaces — honestly, rather than pretending.

const store = new Map(); // key -> { payload, at }
const MAX_AGE_MS = 30 * 60 * 1000; // beyond half an hour, stale data is its own kind of lie

export function rememberGood(key, payload) {
  try { store.set(key, { payload, at: Date.now() }); } catch (e) {}
}

export function lastGood(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MAX_AGE_MS) { store.delete(key); return null; }
  return hit;
}

// True when the failure is a transient Zoho auth/throttle problem rather than a real error.
export function isTransientZohoErr(msg) {
  return /INVALID_TOKEN|invalid oauth token|Access Denied|rate-limited|AUTHENTICATION_FAILURE|\b401\b/i.test(String(msg || ""));
}

/**
 * Decide what to send when a handler failed.
 * Returns { body, cache } — cache is the Cache-Control value the caller MUST set on the failure
 * path (never the success one), so a failure is never cached at the edge.
 */
export function failoverBody(key, errMsg, emptyShape) {
  const hit = lastGood(key);
  if (hit) {
    const ageSec = Math.round((Date.now() - hit.at) / 1000);
    return {
      body: { ...hit.payload, ok: true, stale: true, staleForSec: ageSec, staleReason: isTransientZohoErr(errMsg) ? "reconnecting" : "error" },
      // Stale data may be re-served briefly, but never for as long as fresh data.
      cache: "s-maxage=10, stale-while-revalidate=60",
    };
  }
  return {
    body: { ...(emptyShape || {}), configured: true, ok: false, transient: isTransientZohoErr(errMsg), error: String(errMsg || "") },
    cache: "no-store", // NEVER cache an error — that is what spread one failure to everyone
  };
}
