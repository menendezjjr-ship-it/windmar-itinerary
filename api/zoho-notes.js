// /api/zoho-notes.js — all Notes for a Zoho Deal (project), cleaned for display.
// GET /api/zoho-notes?id=<dealId>
import { rememberGood, failoverBody } from "./_lastgood.js";
import { zohoFetch } from "./_zoho.js";
const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";

let cachedToken = null, tokenExpiry = 0;
function hasCreds() { return !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN); }
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: process.env.ZOHO_CLIENT_ID, client_secret: process.env.ZOHO_CLIENT_SECRET, refresh_token: process.env.ZOHO_REFRESH_TOKEN }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`token refresh failed: ${data.error || JSON.stringify(data)}`);
  cachedToken = data.access_token; tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// Strip Zoho's HTML + @-mention tokens (crm[user#id#name]crm) into plain text.
function clean(s) {
  return String(s || "")
    .replace(/crm\[user#[^\]]*\]crm/g, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#?\w+;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=60");
  const id = String(req.query.id || "").replace(/[^0-9]/g, "");
  // Which module the record lives in. Defaults to Deals so every existing caller is unchanged.
  // Service_Ticket was previously unreachable here: both apps WRITE notes onto a ticket
  // (api/zoho-add-note.js, windmar-operations/api/zoho-note.js) and nothing could read them
  // back, so crew notes went into a hole. Allow-listed rather than passed straight through —
  // this value goes into the request path.
  // indexOf, not a lookup object: `MODULES["constructor"]` would be truthy through the
  // prototype chain and put an attacker-chosen segment into the Zoho request path.
  const MODULES = ["Deals", "Service_Ticket", "Installation", "CustomModule11"];
  const wanted = String(req.query.module || "Deals");
  const moduleName = MODULES.indexOf(wanted) >= 0 ? wanted : "Deals";
  if (!id) return res.status(200).json({ ok: false, error: "id required", notes: [] });
  if (!hasCreds()) return res.status(200).json({ configured: false, ok: false, notes: [] });
  try {
    const token = await getAccessToken();
    const url = `${API_DOMAIN}/crm/${API_VERSION}/${encodeURIComponent(moduleName)}/${id}/Notes?fields=Note_Title,Note_Content,Created_Time,Owner&per_page=100&sort_by=Created_Time&sort_order=desc`;
    const r = await zohoFetch(url);
    if (r.status === 204) return res.status(200).json({ ok: true, count: 0, notes: [] });
    if (!r.ok) {
      const txt = (await r.text().catch(() => "")).slice(0, 160);
      const fo = failoverBody("notes:" + moduleName + ":" + id, `Zoho ${r.status}: ${txt}`, { notes: [], count: 0 });
      res.setHeader("Cache-Control", fo.cache);
      return res.status(200).json(fo.body);
    }
    const d = await r.json();
    const notes = (d.data || []).map((n) => ({
      id: n.id, title: n.Note_Title || "", content: clean(n.Note_Content),
      author: (n.Owner && n.Owner.name) || "", time: n.Created_Time || "",
    })).filter((n) => n.content || n.title);
    const payload = { ok: true, count: notes.length, notes };
    rememberGood("notes:" + moduleName + ":" + id, payload);
    return res.status(200).json(payload);
  } catch (e) {
    // Rarely-called route = always a cold lambda = always mints a token, which is exactly what
    // Zoho refuses. Serve the notes we had rather than an error.
    const fo = failoverBody("notes:" + moduleName + ":" + id, e && e.message || e, { notes: [], count: 0 });
    res.setHeader("Cache-Control", fo.cache);
    return res.status(200).json(fo.body);
  }
}
