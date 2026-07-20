// /api/zoho-update.js — update editable fields on a Zoho Installation OR Service_Ticket record (Coordinator/Calendar edits).
// POST { recordId, module?, fields:{ ApiName: value, ... } }  (module defaults "Installation")
// GET  ?diag=1[&module=Service_Ticket]  → probe whether the Zoho login can UPDATE that module (writes nothing real).
// Only a per-module allowlist of coordinator-safe fields is ever written.
const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";

// Fields a coordinator may edit (Zoho API names — VERIFIED against live Installation
// metadata). Anything else in the payload is ignored. Note: the stage field is "Stage"
// (there is no Installation_Stage); planned-days is "..._default_2"; VIP_Installation is
// read-only in Zoho so it is intentionally NOT writable. Installation_Team is a lookup.
const ALLOWED_INSTALL = new Set([
  "Installation_Notes", "Roof_Notes", "AHJ_Specific_Install_Notes",
  "Stage", "Installation_Team",
  "Installation_Proposed_Date", "Installation_Confirmed_Date", "Installation_Start_Date",
  "Installation_Continuation_Date", "Installation_Complete_Date", "R_R_Completed_Date",
  "Number_of_Days_Needed", "Number_of_Days_Planned_for_Install_default_2",
  "Customer_Access_Granted", "Drone_No_Fly_Zone", "Language_Preference",
]);
// Service_Ticket (CustomModule40) coordinator-safe fields. Ticket_Status is the "Stage".
// Type_of_Service (multiselect) + Assigned_Technician (lookup/user) are intentionally NOT
// writable here — they are shown read-only in the editor to avoid clobbering multi-value /
// lookup data with an invalid single value.
const ALLOWED_SERVICE = new Set([
  "Ticket_Status", "Priority", "Service_Description", "Scheduled_Visit_1",
]);
const ALLOWED_BY_MODULE = { Installation: ALLOWED_INSTALL, Service_Ticket: ALLOWED_SERVICE };
const LOOKUP_FIELDS = new Set(["Installation_Team"]); // sent as { id } to Zoho

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
    // so a scope-mismatch surfaces here without changing anything. ?module= selects which module.
    if (req.method === "GET" && req.query.diag) {
      const dmod = String(req.query.module || "Installation").replace(/[^A-Za-z0-9_]/g, "") || "Installation";
      const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${encodeURIComponent(dmod)}/1`, {
        method: "PUT", headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: [{}] }),
      });
      const txt = await r.text();
      return res.status(200).json({ diag: true, module: dmod, canUpdate: !/OAUTH_SCOPE_MISMATCH/i.test(txt), httpStatus: r.status, sample: txt.slice(0, 220) });
    }

    if (req.method !== "POST") return res.status(200).json({ ok: false, error: "POST required" });
    let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const recordId = String(body.recordId || "").replace(/[^0-9]/g, "");
    if (!recordId) return res.status(200).json({ ok: false, error: "recordId required" });
    const module = body.module || "Installation";
    const ALLOWED = ALLOWED_BY_MODULE[module];
    if (!ALLOWED) return res.status(200).json({ ok: false, error: "unsupported module" });
    const inFields = (body.fields && typeof body.fields === "object") ? body.fields : {};
    const fields = {};
    for (const k of Object.keys(inFields)) {
      if (!ALLOWED.has(k)) continue;
      let v = inFields[k];
      if (LOOKUP_FIELDS.has(k)) {
        // Lookup: Zoho expects { id } (or null to clear). Accept a bare id string or {id}.
        if (v && typeof v === "object" && v.id) v = { id: String(v.id) };
        else if (typeof v === "string" && v.trim()) v = { id: v.trim() };
        else v = null;
      } else if (v === "") {
        v = null; // empty string clears a text/date/picklist field
      }
      fields[k] = v;
    }
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
