// /api/zoho-fields.js — field metadata for the Coordinator record editor.
// GET ?module=Installation → { ok, module,
//   fields: { <api_name>: { api_name, data_type, read_only, picklist?[] } },
//   lookups: { Installation_Team: [{ id, name }] } }
// Powers safe inputs: picklists render as dropdowns of VALID values only, lookups
// (Installation_Team) as a dropdown of allowed records, dates/numbers/booleans as
// the matching input. Read-only + cached (Zoho field defs rarely change).
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

// The only fields the Coordinator editor touches — keeps the metadata response small.
const WANT = new Set([
  "Installation_Notes", "Roof_Notes", "AHJ_Specific_Install_Notes",
  "Stage", "Installation_Team",
  "Installation_Proposed_Date", "Installation_Confirmed_Date", "Installation_Start_Date",
  "Installation_Continuation_Date", "Installation_Complete_Date", "R_R_Completed_Date",
  "Number_of_Days_Needed", "Number_of_Days_Planned_for_Install_default_2",
  "Customer_Access_Granted", "Drone_No_Fly_Zone", "VIP_Installation", "Language_Preference",
]);

// Pull the allowed records of a lookup module (for the dropdown). Bounded to 200.
async function fetchLookup(module, token) {
  try {
    const path = `${encodeURIComponent(module)}/search?criteria=${encodeURIComponent("(id:not_equal:0)")}&fields=Name&per_page=200&page=1`;
    const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (r.status === 204 || !r.ok) return [];
    const rows = (await r.json()).data || [];
    return rows.map((x) => ({ id: String(x.id), name: (x.Name || "").trim() })).filter((x) => x.id && x.name);
  } catch (e) { return []; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  if (!hasCreds()) return res.status(200).json({ ok: false, configured: false, error: "Zoho creds not set" });
  const module = String(req.query.module || "Installation").replace(/[^A-Za-z0-9_]/g, "") || "Installation";
  try {
    const token = await getAccessToken();
    const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/settings/fields?module=${encodeURIComponent(module)}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (!r.ok) throw new Error(`Zoho settings/fields ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const raw = (await r.json()).fields || [];
    const fields = {};
    let needTeam = false;
    for (const f of raw) {
      if (!WANT.has(f.api_name)) continue;
      const out = { api_name: f.api_name, data_type: f.data_type, read_only: !!f.read_only };
      if (Array.isArray(f.pick_list_values) && f.pick_list_values.length) {
        // Valid values only; drop Zoho's "-None-" sentinel (the client adds a blank option).
        out.picklist = f.pick_list_values.map((p) => (p.display_value != null ? p.display_value : p.actual_value)).filter((v) => v && v !== "-None-");
      }
      if (f.data_type === "lookup" && f.api_name === "Installation_Team") needTeam = true;
      fields[f.api_name] = out;
    }
    const lookups = {};
    if (needTeam) lookups.Installation_Team = await fetchLookup("Installation_Team", token);
    return res.status(200).json({ ok: true, module, fields, lookups });
  } catch (e) {
    return res.status(200).json({ ok: false, module, error: String(e && e.message || e) });
  }
}
