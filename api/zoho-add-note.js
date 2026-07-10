// /api/zoho-add-note.js — append a Note to a Zoho record (used to push Plan-Analyzer BOM notes
// onto the Installation record so they show as "installation info" per job).
// POST { recordId, module?, title?, content }  (module defaults to "Installation")
// GET  ?diag=1  → reports whether the Zoho login can CREATE notes (scope check, writes nothing real).
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

async function addNote(token, module, recordId, title, content) {
  const url = `${API_DOMAIN}/crm/${API_VERSION}/${encodeURIComponent(module)}/${encodeURIComponent(recordId)}/Notes`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: [{ Note_Title: title || "BOM Note", Note_Content: content || "" }] }),
  });
  const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt }; }
  return { httpStatus: r.status, body: d };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasCreds()) return res.status(200).json({ ok: false, configured: false, error: "Zoho creds not set" });
  try {
    const token = await getAccessToken();

    // Scope probe: attempt a create with an empty payload. Zoho checks OAuth scope BEFORE data
    // validation, so a scope-mismatch surfaces without creating anything; a "required field"
    // style error means the scope IS present (write allowed).
    if (req.method === "GET" && req.query.diag) {
      const url = `${API_DOMAIN}/crm/${API_VERSION}/Installation/1/Notes`;
      const r = await fetch(url, { method: "POST", headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ data: [{}] }) });
      const txt = await r.text();
      const scopeMismatch = /OAUTH_SCOPE_MISMATCH/i.test(txt);
      return res.status(200).json({ diag: true, canWriteNotes: !scopeMismatch, httpStatus: r.status, sample: txt.slice(0, 200) });
    }

    if (req.method !== "POST") return res.status(200).json({ ok: false, error: "POST required" });
    let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const recordId = String(body.recordId || "").replace(/[^0-9]/g, "");
    if (!recordId) return res.status(200).json({ ok: false, error: "recordId required" });
    const out = await addNote(token, body.module || "Installation", recordId, body.title, String(body.content || ""));
    const rec = out.body && out.body.data && out.body.data[0];
    if (rec && rec.code === "SUCCESS") return res.status(200).json({ ok: true, id: rec.details && rec.details.id });
    const scopeMismatch = JSON.stringify(out.body || {}).indexOf("OAUTH_SCOPE_MISMATCH") >= 0;
    return res.status(200).json({ ok: false, needsWriteScope: scopeMismatch, status: out.httpStatus, error: (rec && (rec.message || rec.code)) || JSON.stringify(out.body).slice(0, 200) });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
