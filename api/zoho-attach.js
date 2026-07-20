// /api/zoho-attach.js — upload a photo as an Attachment on a Zoho record (note-box photo attach).
// POST { recordId, module?, filename, dataBase64, contentType? }  (module defaults "Installation")
//   dataBase64 = base64 of the file bytes (bare or a "data:...;base64,XXXX" data URL).
//   Decodes to a Buffer, wraps it in a Blob/FormData, and POSTs to
//   POST /crm/{ver}/{module}/{recordId}/Attachments so it appears in the record's Attachments.
// GET  ?diag=1[&module=Service_Ticket] → probe whether the login can CREATE attachments (writes nothing real).
// Guards: image/* only, ≤4MB per file (Vercel body ~4.5MB). Returns { ok, id } or a clear error.
const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";
// Per-file raw cap. base64-in-JSON inflates ~33%, and Vercel's request body is hard-capped at
// ~4.5MB, so 3MB raw → ~4.0MB body stays safely under the platform limit. (A 4MB image would
// base64 to ~5.4MB and be rejected before it ever reached us.)
const MAX_BYTES = 3 * 1024 * 1024; // 3MB per file (≈4MB base64 body)
const ALLOWED_MODULES = new Set(["Installation", "Service_Ticket"]);

// Raise the parsed-JSON cap above the 1MB default so a ~4MB base64 body is accepted.
export const config = { api: { bodyParser: { sizeLimit: "5mb" } } };

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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasCreds()) return res.status(200).json({ ok: false, configured: false, error: "Zoho creds not set" });
  try {
    const token = await getAccessToken();

    // Scope probe: POST an (essentially empty) multipart to Attachments. Zoho checks OAuth scope
    // BEFORE validating the file, so a scope-mismatch surfaces without creating anything.
    if (req.method === "GET" && req.query.diag) {
      const dmod = ALLOWED_MODULES.has(String(req.query.module || "")) ? String(req.query.module) : "Installation";
      const fd = new FormData();
      fd.append("file", new Blob([new Uint8Array(0)], { type: "image/png" }), "probe.png");
      const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${dmod}/1/Attachments`, {
        method: "POST", headers: { Authorization: `Zoho-oauthtoken ${token}` }, body: fd,
      });
      const txt = await r.text();
      return res.status(200).json({ diag: true, module: dmod, canAttach: !/OAUTH_SCOPE_MISMATCH/i.test(txt), httpStatus: r.status, sample: txt.slice(0, 220) });
    }

    // TEMPORARY one-off cleanup: remove an attachment. (Removed again right after use — see PR notes.)
    if (req.method === "DELETE") {
      const dmod = ALLOWED_MODULES.has(String(req.query.module || "")) ? String(req.query.module) : "Installation";
      const rid = String(req.query.id || "").replace(/[^0-9]/g, "");
      const aid = String(req.query.aid || "").replace(/[^0-9]/g, "");
      if (!rid || !aid) return res.status(200).json({ ok: false, error: "id and aid required" });
      const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${dmod}/${rid}/Attachments/${aid}`, {
        method: "DELETE", headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt }; }
      const rec = d && d.data && d.data[0];
      return res.status(200).json({ ok: !!(rec && rec.code === "SUCCESS"), status: r.status, sample: txt.slice(0, 220) });
    }

    if (req.method !== "POST") return res.status(200).json({ ok: false, error: "POST required" });
    let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const recordId = String(body.recordId || "").replace(/[^0-9]/g, "");
    if (!recordId) return res.status(200).json({ ok: false, error: "recordId required" });
    const module = ALLOWED_MODULES.has(body.module) ? body.module : "Installation";
    const filename = String(body.filename || "photo.jpg").replace(/[\r\n"]/g, "").slice(0, 120) || "photo.jpg";

    // Decode base64 (accept a bare base64 string or a data: URL).
    let raw = String(body.dataBase64 || "");
    const comma = raw.indexOf(",");
    if (raw.slice(0, 5) === "data:" && comma >= 0) raw = raw.slice(comma + 1);
    let buf;
    try { buf = Buffer.from(raw, "base64"); } catch (e) { buf = null; }
    if (!buf || !buf.length) return res.status(200).json({ ok: false, error: "empty or invalid file data" });
    if (buf.length > MAX_BYTES) return res.status(200).json({ ok: false, error: `file too large (${(buf.length / 1048576).toFixed(1)}MB > 4MB)` });

    let contentType = String(body.contentType || "").toLowerCase();
    if (!/^image\//.test(contentType)) contentType = "image/jpeg"; // enforce image/* (mobile camera)

    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: contentType }), filename);
    const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${module}/${encodeURIComponent(recordId)}/Attachments`, {
      method: "POST", headers: { Authorization: `Zoho-oauthtoken ${token}` }, body: fd,
    });
    const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt }; }
    const rec = d && d.data && d.data[0];
    if (rec && rec.code === "SUCCESS") return res.status(200).json({ ok: true, id: rec.details && rec.details.id, filename });
    const scope = JSON.stringify(d || {}).indexOf("OAUTH_SCOPE_MISMATCH") >= 0;
    return res.status(200).json({ ok: false, needsAttachScope: scope, status: r.status, error: (rec && (rec.message || rec.code)) || JSON.stringify(d).slice(0, 220) });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
