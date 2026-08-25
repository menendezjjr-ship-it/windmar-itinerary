// /api/zoho-health.js — is Zoho reachable right now, and if not, why?
// GET /api/zoho-health   → { ok, token:{...}, probe:{...} }
// Reports booleans and timings only — never a secret. Built because "invalid oauth token" and
// "Access Denied" are different failures with different fixes, and the app surfaced both as a
// generic "API error":
//   INVALID_TOKEN  → this lambda's cached token was invalidated by another lambda's refresh.
//                    Self-heals now: zohoFetch force-refreshes and retries once.
//   Access Denied  → Zoho is RATE-LIMITING the refresh endpoint. Too many access tokens minted
//                    in a short window. Retrying makes it worse; it clears on its own in minutes.
import { zohoFetch, zohoTokenState, hasZohoCreds, ZOHO_API_DOMAIN, ZOHO_API_VERSION } from "./_zoho.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const out = { ok: false, envs: {
    ZOHO_CLIENT_ID: !!process.env.ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET: !!process.env.ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN: !!process.env.ZOHO_REFRESH_TOKEN,
    SUPABASE_SERVICE_ROLE_KEY: !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY),
  }, token: zohoTokenState() };
  // Which Supabase project the shared store actually talks to. If the table was created in a
  // DIFFERENT project than this host, the read 404s and everything above looks identical to
  // "table missing" — so show it rather than guess.
  out.supabaseHost = (process.env.SUPABASE_URL || "https://lmlixmzmzpzgeggvywwb.supabase.co").replace(/^https?:\/\//, "");
  out.supabaseUrlFromEnv = !!process.env.SUPABASE_URL;

  if (!hasZohoCreds()) { out.error = "Zoho creds not set"; return res.status(200).json(out); }
  try {
    // Cheapest possible authenticated call.
    const r = await zohoFetch(`${ZOHO_API_DOMAIN}/crm/${ZOHO_API_VERSION}/Deals?fields=id&per_page=1`);
    const txt = r.status === 204 ? "" : await r.text();
    out.probe = { status: r.status, ok: r.ok };
    if (r.ok || r.status === 204) { out.ok = true; out.state = "healthy"; }
    else if (/INVALID_TOKEN|invalid oauth token/i.test(txt)) { out.state = "stale-token"; out.hint = "cached token was invalidated; zohoFetch retries automatically"; }
    else { out.state = "error"; out.sample = txt.slice(0, 160); }
  } catch (e) {
    const m = String((e && e.message) || e);
    out.error = m;
    // The refresh endpoint itself refused us.
    out.state = /Access Denied|too many/i.test(m) ? "refresh-rate-limited" : "unreachable";
    if (out.state === "refresh-rate-limited")
      out.hint = "Zoho is throttling token refreshes. It clears in a few minutes; do not retry in a loop.";
  }
  return res.status(200).json(out);
}
