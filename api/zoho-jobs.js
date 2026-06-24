// /api/zoho-jobs.js — LIVE WindMar dispatch feed from Zoho CRM.
// Pulls Installations + Service Tickets and maps them to the Itinerary board's
// job shape. Self-contained (no shared imports) so it deploys as a single Vercel
// lambda. Secrets live ONLY in env vars — never shipped to the browser.
//
// Env vars (set the SAME values already used by the windmar-operations project):
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
//   (optional) ZOHO_ACCOUNTS_HOST   default https://accounts.zoho.com
//   (optional) ZOHO_API_DOMAIN      default https://www.zohoapis.com
//   (optional) ZOHO_API_VERSION     default v8   (v2 rejects between: on dates)

const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";
const TZ = "-04:00"; // Florida (EDT). Visit datetimes carry their own offset; this is only for the query window.

let cachedToken = null;
let tokenExpiry = 0;

function hasCreds() {
  return !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN);
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`token refresh failed: ${data.error || JSON.stringify(data)}`);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// Run a paginated CRM search and return ALL matches (criteria/fields are URL-encoded).
async function searchAll(module, criteria, fields, token) {
  const all = [];
  for (let page = 1; page <= 25; page++) {
    const path =
      `${encodeURIComponent(module)}/search?criteria=${encodeURIComponent(criteria)}` +
      `&fields=${encodeURIComponent(fields)}&per_page=200&page=${page}`;
    const res = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (res.status === 204) break; // no records
    if (!res.ok) throw new Error(`Zoho ${module} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const batch = data.data || [];
    all.push(...batch);
    if (batch.length < 200 || !(data.info && data.info.more_records)) break;
  }
  return all;
}

const lookup = (v) => (v && typeof v === "object" ? v.name : v) || "";

// "DL8425 Roberto Ramos 5456 Placid Lakes Boulevard Lake Placid FL"
//   -> { code, num, customer, address }
function parseDeal(dealName) {
  const out = { code: "", num: "", customer: "", address: "" };
  if (!dealName) return out;
  const m = dealName.match(/^\s*((?:RDL|RL|DL|MSP|S)\d{2,})\s+(.*)$/i);
  if (!m) { out.customer = dealName.trim(); return out; }
  const full = m[1].toUpperCase();
  out.code = (full.match(/^(RDL|RL|DL|MSP|S)/) || [])[1] || "";
  out.num = full;
  const rest = m[2].trim();
  // customer = words before the first street number; address = the rest.
  const a = rest.match(/^(.+?)[\s,]+(\d{1,6}[\s,].+)$/);
  if (a) { out.customer = a[1].replace(/[\s,]+$/, "").trim(); out.address = a[2].trim(); }
  else { out.customer = rest; }
  return out;
}

// Split a Zoho datetime ("2026-06-25T09:00:00-04:00") -> { date, time, hhmm }.
function splitDT(dt) {
  if (!dt || typeof dt !== "string") return { date: null, time: null, hhmm: null };
  const date = dt.slice(0, 10);
  const tm = dt.slice(11, 16);
  if (!/^\d{2}:\d{2}$/.test(tm)) return { date, time: null, hhmm: null };
  let [h, mm] = tm.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return { date, time: `${h12}:${String(mm).padStart(2, "0")} ${ap}`, hhmm: tm };
}

// Normalize a Zoho crew/team/tech label into a stable {id,label}.
//  "In-House #2" and "In House #2" collapse to the same crew.
function normCrew(raw) {
  let label = (raw || "Unassigned").trim();
  label = label.replace(/in[-\s]?house/i, "In House");
  const id = "z-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return { id, label };
}

const INSTALL_FIELDS = "Name,Installation_Start_Date,Installation_Complete_Date,Installation_Team,Deal,MSP_Upgrade_Required,Battery_Type,Language_Preference,Number_of_Days_Needed";
const SERVICE_FIELDS = "Name,Scheduled_Visit_1,Assigned_Technician,Associated_Deal,Ticket_Status,Type_of_Service,Service_Description";

function mapInstall(r, todayISO) {
  const deal = parseDeal(lookup(r.Deal));
  const crew = normCrew(lookup(r.Installation_Team) || "Unassigned");
  const date = r.Installation_Start_Date || null;
  let status = "scheduled";
  if (r.Installation_Complete_Date) status = "done";
  else if (date && date < todayISO) status = "pastdue";
  const msp = r.MSP_Upgrade_Required === "MSP" || r.MSP_Upgrade_Required === true;
  const scopeBits = [];
  if (r.Battery_Type) scopeBits.push(lookup(r.Battery_Type));
  if (msp) scopeBits.push("MSP upgrade");
  if (r.Number_of_Days_Needed) scopeBits.push(`${r.Number_of_Days_Needed}-day`);
  return {
    id: deal.num || r.Name,
    kind: "install",
    code: deal.code || "DL",
    project: deal.customer || r.Name,
    address: deal.address || "",
    crew: crew.id,
    crewLabel: crew.label,
    date,
    window: "All day",
    hhmm: "00:00",
    status,
    msp,
    phone: "",
    geo: null,
    scope: scopeBits.join(" · ") || "Installation",
  };
}

function mapService(r, todayISO) {
  const deal = parseDeal(lookup(r.Associated_Deal));
  const crew = normCrew(lookup(r.Assigned_Technician) || "Unassigned");
  const v = splitDT(r.Scheduled_Visit_1);
  const st = (r.Ticket_Status || "").trim();
  let status = "scheduled";
  if (/^(7|8)\b/.test(st) || /complete/i.test(st)) status = "done";
  else if (v.date && v.date < todayISO) status = "pastdue";
  const svc = Array.isArray(r.Type_of_Service) ? r.Type_of_Service.join(", ") : (r.Type_of_Service || "");
  return {
    id: deal.num ? `${deal.num} · ${r.Name}` : r.Name,
    kind: "service",
    code: "S",
    project: deal.customer || r.Name,
    address: deal.address || "",
    crew: crew.id,
    crewLabel: crew.label,
    date: v.date,
    window: v.time || "Time TBD",
    hhmm: v.hhmm || "23:59",
    status,
    msp: false,
    phone: "",
    geo: null,
    scope: (svc || "Service").replace(/\(\d+\)\s*/g, "").trim(),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
  if (!hasCreds()) return res.status(200).json({ configured: false, ok: false, jobs: [] });

  // Date window: default today-14 .. today+45 (covers day nav + the monthly snapshot).
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const shift = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : shift(-14);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : shift(45);
  const todayISO = iso(today);

  try {
    const token = await getAccessToken();
    const [installs, services] = await Promise.all([
      searchAll("Installation", `(Installation_Start_Date:between:${from},${to})`, INSTALL_FIELDS, token),
      searchAll("Service_Ticket", `(Scheduled_Visit_1:between:${from}T00:00:00${TZ},${to}T23:59:59${TZ})`, SERVICE_FIELDS, token),
    ]);
    const jobs = [
      ...installs.map((r) => mapInstall(r, todayISO)),
      ...services.map((r) => mapService(r, todayISO)),
    ].filter((j) => j.date);

    return res.status(200).json({
      configured: true,
      ok: true,
      updated: new Date().toISOString(),
      range: { from, to },
      counts: { installs: installs.length, services: services.length, jobs: jobs.length },
      jobs,
    });
  } catch (e) {
    return res.status(200).json({ configured: true, ok: false, error: String(e && e.message || e), jobs: [] });
  }
}
