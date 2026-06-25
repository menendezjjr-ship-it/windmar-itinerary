// /api/zoho-attachments.js — per-stage job documents for a project (Deal).
// WindMar stores files on the pipeline's stage sub-modules (linked to the Deal):
//   NTP, Site_Survey (Site Visit), System_Info_Engineering (Engineering incl. FDA),
//   Installation (Permitting + Install). GET /api/zoho-attachments?id=<dealId>
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
function parseFiles(field) {
  if (!Array.isArray(field)) return [];
  return field.map((f) => ({ aid: f.id, name: f.File_Name__s || "file", size: f.Size__s || 0, modified: f.Modified_Time__s || f.Created_Time__s || "" })).filter((f) => f.aid);
}
// Each stage's file-upload fields, fetched via the Deal's related list. `module` is
// used to build the secure download URL (download_fields_attachment is record-scoped).
const SOURCES = [
  { rel: "NTP", module: "NTP", stage: "NTP", fields: [
    { api: "Final_Design_to_be_Installed", label: "Approved Final Design" },
    { api: "Signed_Design_Document", label: "Signed Design Document" },
    { api: "Roof_Conditions_Report", label: "Roof Conditions Report" },
    { api: "HOA_Form_Upload", label: "HOA Form" },
  ] },
  { rel: "Related_List_Name_6", module: "Site_Survey", stage: "Site Visit", fields: [
    { api: "Preliminary_Design_Upload_File", label: "Preliminary Design" },
    { api: "Signed_POA_Permit_App", label: "Signed POA / Permit App" },
    { api: "Blank_NOC_form_for_SS_Tech", label: "NOC Form" },
    { api: "HOA_Form_Upload", label: "HOA Form" },
  ] },
  { rel: "System_Info_and_Engineering", module: "System_Info_Engineering", stage: "Engineering", fields: [
    { api: "Approved_FDA", label: "Approved FDA" },
    { api: "Signed_Contract_O_I", label: "Signed Contract / O&I" },
  ] },
  { rel: "Installation_Info", module: "Installation", stage: "Permitting", fields: [
    { api: "Permit_Package", label: "Permit Package / Plans" },
  ] },
  { rel: "Installation_Info", module: "Installation", stage: "Install", fields: [
    { api: "BOM", label: "BOM" },
  ] },
];
const STAGE_ORDER = ["NTP", "Site Visit", "Engineering", "Permitting", "Install", "Post-Installation"];

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
  const id = String(req.query.id || "").replace(/[^0-9]/g, "");
  if (!id) return res.status(200).json({ ok: false, error: "id required", groups: [] });
  if (!hasCreds()) return res.status(200).json({ configured: false, ok: false, groups: [] });
  try {
    const token = await getAccessToken();
    const byStage = {};
    // One fetch per related list (cache so Installation_Info isn't fetched twice).
    const relCache = {};
    for (const src of SOURCES) {
      try {
        if (!relCache[src.rel]) {
          const allFields = [...new Set(SOURCES.filter((s) => s.rel === src.rel).flatMap((s) => s.fields.map((f) => f.api)))].concat("Name").join(",");
          const path = `Deals/${id}/${src.rel}?fields=${encodeURIComponent(allFields)}&per_page=20`;
          const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
          relCache[src.rel] = (r.status === 204 || !r.ok) ? [] : ((await r.json()).data || []);
        }
        relCache[src.rel].forEach((rec) => {
          src.fields.forEach((ff) => {
            parseFiles(rec[ff.api]).forEach((f) => {
              (byStage[src.stage] = byStage[src.stage] || []).push({ module: src.module, recordId: rec.id, aid: f.aid, name: f.name, size: f.size, modified: f.modified, label: ff.label });
            });
          });
        });
      } catch (e) { /* skip this source */ }
    }
    const groups = STAGE_ORDER.filter((s) => byStage[s] && byStage[s].length).map((s) => ({ stage: s, files: byStage[s].sort((a, b) => String(b.modified).localeCompare(String(a.modified))) }));
    const count = groups.reduce((n, g) => n + g.files.length, 0);
    return res.status(200).json({ ok: true, count, groups });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e), groups: [] });
  }
}
