// /api/zoho-search.js — all-time word search across Zoho CRM Deals.
// Powers the "📁 From Zoho records" augmentation under the Projects Pipeline and
// Calendar search bars: the loaded lists only cover the operational pipeline / calendar
// window, so this reaches ANY deal (any stage, all-time) by keyword.
// Self-contained lambda; secrets live ONLY in env vars (ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN).

const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";
const ORG = "org666151142";

let cachedToken = null, tokenExpiry = 0;
function hasCreds() { return !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN); }

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET, refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`token refresh failed: ${data.error || JSON.stringify(data)}`);
  cachedToken = data.access_token; tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

const lookup = (v) => (v && typeof v === "object" ? v.name : v) || "";
const clean = (s) => String(s || "").replace(/[\s,]+$/, "").trim();

function fmtPhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === "1") return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return s || "";
}

// "DL8467 Frank Roman 7420 Olin Way Orlando FL" -> { num, customer }
function parseDeal(name) {
  const out = { num: "", customer: "" };
  if (!name) return out;
  const m = name.match(/^\s*((?:RDL|RL|DL|MSP|S)\d{2,})\s+(.*)$/i);
  if (!m) { out.customer = name.trim(); return out; }
  out.num = m[1].toUpperCase();
  const rest = m[2].trim();
  const a = rest.match(/^(.+?)[\s,]+\d{1,6}[\s,].+$/);
  out.customer = a ? a[1].replace(/[\s,]+$/, "").trim() : rest;
  return out;
}

const FIELDS = "Deal_Name,Stage,Client_Phone,Client_Mobile,Address,City,State,Zip,System_Size_kW1";

export default async function handler(req, res) {
  const q = String(req.query.q || "").trim();
  if (q.length < 3) { res.setHeader("Cache-Control", "no-store"); return res.status(200).json({ ok: false, error: "q too short", results: [] }); }
  if (!hasCreds()) { res.setHeader("Cache-Control", "no-store"); return res.status(200).json({ ok: false, configured: false, results: [] }); }
  try {
    const token = await getAccessToken();
    const path = `Deals/search?word=${encodeURIComponent(q)}&fields=${encodeURIComponent(FIELDS)}&per_page=25&page=1`;
    const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (r.status === 204) { res.setHeader("Cache-Control", "s-maxage=30"); return res.status(200).json({ ok: true, q, results: [] }); }
    if (!r.ok) throw new Error(`Zoho Deals ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const rows = (await r.json()).data || [];
    const results = rows.slice(0, 25).map((d) => {
      const p = parseDeal(d.Deal_Name);
      const address = [clean(d.Address), clean(d.City), [clean(d.State), clean(d.Zip)].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      return {
        name: p.customer || d.Deal_Name || "",
        dl: p.num || "",
        address,
        stage: d.Stage || "",
        phone: fmtPhone(d.Client_Mobile || d.Client_Phone),
        kw: (d.System_Size_kW1 != null && d.System_Size_kW1 !== 0) ? d.System_Size_kW1 : null,
        dealId: d.id,
        recordId: d.id,
        zohoUrl: `https://crm.zoho.com/crm/${ORG}/tab/Potentials/${d.id}`,
      };
    });
    res.setHeader("Cache-Control", "s-maxage=30");
    return res.status(200).json({ ok: true, q, count: results.length, results });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: false, q, error: String(e && e.message || e), results: [] });
  }
}
