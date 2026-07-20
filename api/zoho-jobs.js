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
// Zoho mixes OLD + NEW labels for the SAME crew (In House #2 = Elite Crew #2,
// T2 - Leonardo Torres = Crew #1S, Holi = Crew H, …). Collapse to one canonical
// crew so each shows once on the calendar with a single color.
function canonTeam(raw) {
  const s = (raw || "Unassigned").trim();
  const n = s.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  if (/elite crew #?3|in ?house #?3|william sierra|luis vargas/.test(n)) return "Elite Crew #3";
  if (/elite crew #?2|in ?house #?2|tailor herrera|maykel pimentel/.test(n)) return "Elite Crew #2";
  if (/crew #?1s|leonardo torres/.test(n)) return "Crew #1S";
  if (/crew #?2s|david radke/.test(n)) return "Crew #2S";
  if (/crew #?3s|luis morales/.test(n)) return "Crew #3S";
  if (/crew h|holi/.test(n)) return "Crew H";
  if (/roofing/.test(n)) return "Windmar Roofing";
  return s.replace(/^t\d+\s*[-–]\s*/i, "").trim() || "Unassigned"; // strip stray "T2 - " tech prefix
}
function normCrew(raw) {
  const label = canonTeam(raw);
  const id = "z-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return { id, label };
}

const INSTALL_FIELDS = "Name,Installation_Start_Date,Installation_Complete_Date,Installation_Team,Deal,MSP_Upgrade_Required,Battery_Type,Language_Preference,Number_of_Days_Needed,Permit_Package,BOM,Installation_Notes";
// A Zoho file-upload field is an array of file objects; return the latest (newest-first).
function latestFile(field) {
  if (!Array.isArray(field)) return null;
  const files = field
    .map((f) => ({ aid: f.id, name: f.File_Name__s || "download", modified: f.Modified_Time__s || f.Created_Time__s || "" }))
    .filter((f) => f.aid)
    .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  return files[0] || null;
}
const SERVICE_FIELDS = "Name,Scheduled_Visit_1,Assigned_Technician,Associated_Deal,Ticket_Status,Type_of_Service,Service_Description,Priority";

export function mapInstall(r, todayISO) {
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
    recordId: r.id,           // real Zoho Installation record id (for file downloads)
    plan: latestFile(r.Permit_Package), // latest Permit Package / plans
    bom: latestFile(r.BOM),             // latest BOM
    num: deal.num || "",
    kind: "install",
    code: deal.code || "DL",
    project: deal.customer || r.Name,
    address: deal.address || "",
    crew: crew.id,
    crewLabel: crew.label,
    date,
    days: r.Number_of_Days_Needed || 1, // multi-day jobs fill every day they span
    window: "All day",
    hhmm: "00:00",
    status,
    cat: status === "done" ? "completed" : status, // installs: completed | pastdue | scheduled
    rawStatus: r.Installation_Complete_Date ? "Installed" : "",
    msp,
    phone: "",
    geo: null,
    scope: scopeBits.join(" · ") || "Installation",
    installNotes: (r.Installation_Notes || "").trim(), // coordinator gate codes / pending-install to-dos (shown on hover + Coordinator detail)
  };
}

export function mapService(r, todayISO) {
  const deal = parseDeal(lookup(r.Associated_Deal));
  const crew = normCrew(lookup(r.Assigned_Technician) || "Unassigned");
  const v = splitDT(r.Scheduled_Visit_1);
  const st = (r.Ticket_Status || "").trim();
  let status = "scheduled";
  if (/^(7|8)\b/.test(st) || /complete/i.test(st)) status = "done";
  else if (v.date && v.date < todayISO) status = "pastdue";
  // Richer category from the Zoho Ticket_Status for the stage dashboard.
  let cat;
  if (/^(7|8)\b/.test(st) || /complete/i.test(st)) cat = "completed";
  else if (/^5\b/.test(st) || /reschedul/i.test(st)) cat = "reschedule";
  else if (/^3\b/.test(st) || /need.*schedule/i.test(st)) cat = "needs_schedule";
  else if (/^6\b/.test(st) || /tier|rma|warranty/i.test(st)) cat = "in_progress";
  else if (v.date && v.date < todayISO) cat = "pastdue";
  else cat = "scheduled";
  const svc = Array.isArray(r.Type_of_Service) ? r.Type_of_Service.join(", ") : (r.Type_of_Service || "");
  return {
    id: deal.num ? `${deal.num} · ${r.Name}` : r.Name,
    recordId: r.id,           // real Zoho Service_Ticket record id (for editing/attachments)
    num: deal.num || r.Name,
    kind: "service",
    code: "S",
    priority: r.Priority || "",
    ticketNo: r.Name,
    project: deal.customer || r.Name,
    address: deal.address || "",
    crew: crew.id,
    crewLabel: crew.label,
    date: v.date,
    window: v.time || "Time TBD",
    hhmm: v.hhmm || "23:59",
    status,
    cat,
    rawStatus: st,
    msp: false,
    phone: "",
    geo: null,
    scope: (svc || "Service").replace(/\(\d+\)\s*/g, "").trim(),
    desc: (r.Service_Description || "").trim(), // full work-order description for the ticket
  };
}

// Editable Installation fields surfaced to the Coordinator editor. VERIFIED against
// live Zoho: the Stage field is "Stage" (NOT Installation_Stage); planned-days is
// "Number_of_Days_Planned_for_Install_default_2"; VIP is "VIP_Installation" (read-only);
// Installation_Team is a lookup (returned as {id,name}).
const EDIT_FIELDS = [
  "Installation_Notes", "Roof_Notes", "AHJ_Specific_Install_Notes",
  "Stage", "Installation_Team",
  "Installation_Proposed_Date", "Installation_Confirmed_Date", "Installation_Start_Date",
  "Installation_Continuation_Date", "Installation_Complete_Date", "R_R_Completed_Date",
  "Number_of_Days_Needed", "Number_of_Days_Planned_for_Install_default_2",
  "Customer_Access_Granted", "Drone_No_Fly_Zone", "VIP_Installation", "Language_Preference",
];

// Look up a single DL's Installation record (word-search the Installation module).
// Used by the Coordinator detail view: a Ready-to-Schedule install often has no start
// date yet, so it won't appear in the date-windowed feed — this fetches it directly.
// Returns recordId + installNotes (kept for the hover tip) + the full editable `rec`.
async function lookupDL(dl, token) {
  const flds = ["Deal"].concat(EDIT_FIELDS).filter((v, i, a) => a.indexOf(v) === i);
  const path = `Installation/search?word=${encodeURIComponent(dl)}` +
    `&fields=${encodeURIComponent(flds.join(","))}&per_page=20`;
  const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (r.status === 204) return { installNotes: "", recordId: "", count: 0, rec: null };
  if (!r.ok) throw new Error(`Zoho Installation ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows = (await r.json()).data || [];
  const key = String(dl).toUpperCase().replace(/\s+/g, "");
  // Prefer the record whose Deal name begins with the exact DL; then one that actually has notes.
  const exact = rows.filter((x) => lookup(x.Deal).toUpperCase().replace(/\s+/g, "").indexOf(key) === 0);
  const pool = exact.length ? exact : rows;
  const withNotes = pool.filter((x) => (x.Installation_Notes || "").trim());
  const pick = withNotes[0] || pool[0] || null;
  let rec = null;
  if (pick) {
    rec = {};
    for (const k of EDIT_FIELDS) {
      const v = pick[k];
      if (k === "Installation_Team") rec[k] = (v && typeof v === "object") ? { id: String(v.id || ""), name: v.name || "" } : null;
      else rec[k] = (v === undefined ? null : v);
    }
  }
  return {
    installNotes: pick ? (pick.Installation_Notes || "").trim() : "",
    recordId: pick ? pick.id : "",
    count: rows.length,
    rec,
  };
}

// Editable Service_Ticket fields surfaced to the Coordinator/Calendar editor. Ticket_Status is
// the "Stage". Type_of_Service (multiselect) + Assigned_Technician (lookup) are returned for
// read-only display; only Ticket_Status/Priority/Service_Description/Scheduled_Visit_1 are writable.
const SERVICE_EDIT_FIELDS = [
  "Ticket_Status", "Priority", "Type_of_Service", "Service_Description",
  "Scheduled_Visit_1", "Assigned_Technician",
];

// Fetch one Service_Ticket record by id and return its editable fields (Calendar/Coordinator
// service editor). A DL can carry both an install and a service ticket, so callers resolve the
// exact ticket by its recordId (not by DL). Returns { recordId, module, rec }.
async function lookupService(recordId, token) {
  const path = `Service_Ticket/${encodeURIComponent(recordId)}?fields=${encodeURIComponent(SERVICE_EDIT_FIELDS.join(","))}`;
  const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (r.status === 204) return { recordId: "", module: "Service_Ticket", rec: null, count: 0 };
  if (!r.ok) throw new Error(`Zoho Service_Ticket ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const row = ((await r.json()).data || [])[0] || null;
  if (!row) return { recordId: "", module: "Service_Ticket", rec: null, count: 0 };
  const rec = {};
  for (const k of SERVICE_EDIT_FIELDS) {
    const v = row[k];
    if (k === "Assigned_Technician") rec[k] = (v && typeof v === "object") ? { id: String(v.id || ""), name: v.name || "" } : (v || null);
    else if (k === "Type_of_Service") rec[k] = Array.isArray(v) ? v : (v == null ? [] : [v]);
    else rec[k] = (v === undefined ? null : v);
  }
  return { recordId: String(row.id), module: "Service_Ticket", rec, count: 1 };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
  if (!hasCreds()) return res.status(200).json({ configured: false, ok: false, jobs: [] });

  // Single Service_Ticket editable-record lookup (Calendar/Coordinator service editor): ?svc=<recordId>
  const svc = String(req.query.svc || "").replace(/[^0-9]/g, "");
  if (svc) {
    try {
      const token = await getAccessToken();
      const out = await lookupService(svc, token);
      return res.status(200).json({ configured: true, ok: true, ...out });
    } catch (e) {
      return res.status(200).json({ configured: true, ok: false, recordId: "", module: "Service_Ticket", rec: null, error: String(e && e.message || e) });
    }
  }

  // Single-DL Installation-Notes lookup (Coordinator detail): /api/zoho-jobs?dl=DL8467
  const dl = String(req.query.dl || "").trim();
  if (dl) {
    try {
      const token = await getAccessToken();
      const out = await lookupDL(dl, token);
      return res.status(200).json({ configured: true, ok: true, dl, ...out });
    } catch (e) {
      return res.status(200).json({ configured: true, ok: false, dl, installNotes: "", recordId: "", error: String(e && e.message || e) });
    }
  }

  // Date window: default today-14 .. today+45 (covers day nav + the monthly snapshot).
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const shift = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : shift(-14);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : shift(45);
  const todayISO = iso(today);

  try {
    const token = await getAccessToken();
    const only = String(req.query.only || ""); // only=install → skip service tickets (Install Map's all-time pull)
    const [installs, services] = await Promise.all([
      only === "service" ? Promise.resolve([]) : searchAll("Installation", `(Installation_Start_Date:between:${from},${to})`, INSTALL_FIELDS, token),
      only === "install" ? Promise.resolve([]) : searchAll("Service_Ticket", `(Scheduled_Visit_1:between:${from}T00:00:00${TZ},${to}T23:59:59${TZ})`, SERVICE_FIELDS, token),
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
