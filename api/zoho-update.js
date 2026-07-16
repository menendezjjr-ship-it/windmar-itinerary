// /api/zoho-update.js — update editable fields on a Zoho Installation record (Coordinator tab edits).
// POST { recordId, module?, fields:{ ApiName: value, ... } }  (module defaults "Installation")
// GET  ?diag=1  → probe whether the Zoho login can UPDATE module records (writes nothing real).
// Only an allowlist of coordinator-safe fields is ever written.
const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";

// Fields a coordinator may edit (Zoho API names). Anything else in the payload is ignored.
const ALLOWED = new Set([
  "Installation_Notes", "Roof_Notes", "AHJ_Specific_Install_Notes",
  "Installation_Stage", "Installation_Team",
  "Installation_Proposed_Date", "Installation_Confirmed_Date", "Installation_Start_Date",
  "Installation_Continuation_Date", "Installation_Complete_Date", "R_R_Completed_Date",
  "Number_of_Days_Needed", "Number_of_Days_Planned_for_Install",
  "Customer_Access_Granted", "Drone_No_Fly_Zone", "VIP_Inspection", "Language_Preference",
]);

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

    // Scope probe — PUT with an empty record; Zoho checks OAuth scope before data validation,
    // so a scope-mismatch surfaces here without changing anything.
    if (req.method === "GET" && req.query.diag) {
      const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/Installation/1`, {
        method: "PUT", headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: [{}] }),
      });
      const txt = await r.text();
      return res.status(200).json({ diag: true, canUpdate: !/OAUTH_SCOPE_MISMATCH/i.test(txt), httpStatus: r.status, sample: txt.slice(0, 220) });
    }

    if (req.method !== "POST") return res.status(200).json({ ok: false, error: "POST required" });
    let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const recordId = String(body.recordId || "").replace(/[^0-9]/g, "");
    if (!recordId) return res.status(200).json({ ok: false, error: "recordId required" });
    const module = body.module || "Installation";
    const inFields = (body.fields && typeof body.fields === "object") ? body.fields : {};
    const fields = {};
    for (const k of Object.keys(inFields)) if (ALLOWED.has(k)) fields[k] = inFields[k];
    if (!Object.keys(fields).length) return res.status(200).json({ ok: false, error: "no editable fields in payload" });

    const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${encodeURIComponent(module)}/${encodeURIComponent(recordId)}`, {
      method: "PUT", headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: [fields] }),
    });
    const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt }; }
    const rec = d && d.data && d.data[0];
    if (rec && rec.code === "SUCCESS") return res.status(200).json({ ok: true, id: recordId, updated: Object.keys(fields) });
    const scope = JSON.stringify(d || {}).indexOf("OAUTH_SCOPE_MISMATCH") >= 0;
    return res.status(200).json({ ok: false, needsUpdateScope: scope, status: r.status, error: (rec && (rec.message || rec.code)) || JSON.stringify(d).slice(0, 220) });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
