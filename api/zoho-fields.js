// /api/zoho-fields.js — field metadata for the Coordinator record editor.
// GET ?module=Installation → { ok, module, source, fields:{ <api_name>:{data_type,read_only,picklist?} },
//   lookups:{ Installation_Team:[{id,name}] } }
//
// Powers safe inputs: picklists render as dropdowns of VALID values only, the
// Installation_Team lookup as a dropdown of allowed crew records, dates/numbers/
// booleans as the matching input.
//
// NOTE on scope: the live Zoho login has module READ + UPDATE but NOT the
// settings.fields.READ scope, so GET /settings/fields returns OAUTH_SCOPE_MISMATCH.
// We therefore ship a VERIFIED baseline (confirmed against live Installation
// metadata) and only *upgrade* it from /settings/fields when that call succeeds
// (source:"live"). The Installation_Team options are fetched via the records
// search API, which the module READ scope allows. Cached (defs rarely change).
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

// VERIFIED baseline for the Installation module (live-confirmed API names, types,
// picklist values). Used directly when the settings.fields scope is unavailable.
const STAGE_PICKS = [
  "Permit Approved - HOA is Pending", "Permit Approved - Pending Roof", "Permit Approved - Pending MSP",
  "Permit Approved - Pending Umbrella", "Pending Schedule", "Pending Schedule - Batteries Needed",
  "Scheduled", "In Progress", "Installation Repair Required", "Installation Complete - Need QA",
  "Installation Complete - CP Work Required", "AHJ Revision Required", "Solar Installation Complete - Need Batteries",
  "Solar Complete - Need MSP ASAP", "Complete", "On Hold Pending Financing", "On Hold Possible Cancellation",
  "On Hold  - Need Financing", "On Hold - Need HOA", "On Hold - Need Roof", "On Hold - See Notes",
  "QA Complete - Move To Final Inspection",
];
const BASELINE = {
  Installation: {
    Installation_Notes: { data_type: "textarea", read_only: false },
    Roof_Notes: { data_type: "textarea", read_only: false },
    AHJ_Specific_Install_Notes: { data_type: "textarea", read_only: false },
    Stage: { data_type: "picklist", read_only: false, picklist: STAGE_PICKS },
    Installation_Team: { data_type: "lookup", read_only: false, lookup_module: "Installation_Team" },
    Installation_Proposed_Date: { data_type: "date", read_only: false },
    Installation_Confirmed_Date: { data_type: "date", read_only: false },
    Installation_Start_Date: { data_type: "date", read_only: false },
    Installation_Continuation_Date: { data_type: "date", read_only: false },
    Installation_Complete_Date: { data_type: "date", read_only: false },
    R_R_Completed_Date: { data_type: "date", read_only: false },
    Number_of_Days_Needed: { data_type: "picklist", read_only: false, picklist: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] },
    Number_of_Days_Planned_for_Install_default_2: { data_type: "integer", read_only: false },
    Customer_Access_Granted: { data_type: "boolean", read_only: false },
    Drone_No_Fly_Zone: { data_type: "boolean", read_only: false },
    VIP_Installation: { data_type: "text", read_only: true },
    Language_Preference: { data_type: "text", read_only: false },
  },
};

// Pull the allowed records of a lookup module (for the dropdown). Uses module READ. Bounded to 200.
async function fetchLookup(module, token) {
  try {
    const path = `${encodeURIComponent(module)}/search?criteria=${encodeURIComponent("(id:not_equal:0)")}&fields=Name&per_page=200&page=1`;
    const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (r.status === 204 || !r.ok) return [];
    const rows = (await r.json()).data || [];
    return rows.map((x) => ({ id: String(x.id), name: (x.Name || "").trim() })).filter((x) => x.id && x.name);
  } catch (e) { return []; }
}

// Best-effort upgrade of picklist values / read-only flags from live settings/fields.
// Silently returns false (keep baseline) if the scope isn't granted.
async function tryLiveOverride(module, fields, token) {
  try {
    const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/settings/fields?module=${encodeURIComponent(module)}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!r.ok) return false;
    const raw = (await r.json()).fields || [];
    for (const f of raw) {
      const cur = fields[f.api_name];
      if (!cur) continue;
      cur.data_type = f.data_type;
      cur.read_only = !!f.read_only;
      if (Array.isArray(f.pick_list_values) && f.pick_list_values.length) {
        cur.picklist = f.pick_list_values.map((p) => (p.display_value != null ? p.display_value : p.actual_value)).filter((v) => v && v !== "-None-");
      }
    }
    return true;
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  if (!hasCreds()) return res.status(200).json({ ok: false, configured: false, error: "Zoho creds not set" });
  const module = String(req.query.module || "Installation").replace(/[^A-Za-z0-9_]/g, "") || "Installation";
  const base = BASELINE[module];
  if (!base) return res.status(200).json({ ok: false, module, error: "unsupported module (no baseline)" });
  try {
    const token = await getAccessToken();
    // Deep-copy the baseline so the cached module object is never mutated across requests.
    const fields = JSON.parse(JSON.stringify(base));
    const live = await tryLiveOverride(module, fields, token);
    const lookups = {};
    for (const k of Object.keys(fields)) {
      if (fields[k].data_type === "lookup") {
        const lm = fields[k].lookup_module || k;
        lookups[k] = await fetchLookup(lm, token);
      }
    }
    return res.status(200).json({ ok: true, module, source: live ? "live" : "baseline", fields, lookups });
  } catch (e) {
    return res.status(200).json({ ok: false, module, error: String(e && e.message || e) });
  }
}
