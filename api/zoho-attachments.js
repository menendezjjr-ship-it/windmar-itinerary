// /api/zoho-attachments.js — per-stage job documents for a project (Deal).
// WindMar stores files on the linked Installation record: Permit Package (Permitting)
// and BOM (Install). GET /api/zoho-attachments?id=<dealId>
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
// A Zoho file-upload field is an array of file objects; normalize + newest first.
function parseFiles(field, installId) {
  if (!Array.isArray(field)) return [];
  return field
    .map((f) => ({ aid: f.id, installId, name: f.File_Name__s || "file", size: f.Size__s || 0, modified: f.Modified_Time__s || f.Created_Time__s || "" }))
    .filter((f) => f.aid)
    .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
  const id = String(req.query.id || "").replace(/[^0-9]/g, "");
  if (!id) return res.status(200).json({ ok: false, error: "id required", groups: [] });
  if (!hasCreds()) return res.status(200).json({ configured: false, ok: false, groups: [] });
  try {
    const token = await getAccessToken();
    const path = `Installation/search?criteria=${encodeURIComponent(`(Deal:equals:${id})`)}&fields=${encodeURIComponent("Name,Permit_Package,BOM")}&per_page=10`;
    const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (r.status === 204) return res.status(200).json({ ok: true, groups: [], count: 0 });
    if (!r.ok) return res.status(200).json({ ok: false, error: `Zoho ${r.status}: ${(await r.text()).slice(0, 160)}`, groups: [] });
    const data = await r.json();
    const permit = [], bom = [];
    (data.data || []).forEach((ins) => { permit.push(...parseFiles(ins.Permit_Package, ins.id)); bom.push(...parseFiles(ins.BOM, ins.id)); });
    const groups = [
      { key: "permit", stage: "Permitting", label: "Permit Package / Plans", files: permit },
      { key: "bom", stage: "Install", label: "BOM", files: bom },
    ].filter((g) => g.files.length);
    return res.status(200).json({ ok: true, count: permit.length + bom.length, groups });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e), groups: [] });
  }
}
