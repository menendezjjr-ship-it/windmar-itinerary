// /api/zoho-file.js — securely stream a file from an Installation file-upload field.
// GET /api/zoho-file?id=<installId>&aid=<attachmentId>&name=<filename>
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
export default async function handler(req, res) {
  const id = String(req.query.id || "").replace(/[^0-9]/g, "");
  const aid = String(req.query.aid || "").replace(/[^a-zA-Z0-9]/g, "");
  const name = String(req.query.name || "file").replace(/[^\w.\- ]/g, "").slice(0, 120);
  if (!id || !aid) return res.status(400).json({ ok: false, error: "id and aid required" });
  if (!hasCreds()) return res.status(503).json({ ok: false, error: "Zoho not configured" });
  try {
    const token = await getAccessToken();
    const url = `${API_DOMAIN}/crm/${API_VERSION}/Installation/${id}/actions/download_fields_attachment?fields_attachment_id=${encodeURIComponent(aid)}`;
    const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (!r.ok) return res.status(200).json({ ok: false, status: r.status, error: (await r.text()).slice(0, 200) });
    const ct = r.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
