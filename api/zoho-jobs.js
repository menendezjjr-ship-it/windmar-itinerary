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
  // Unmapped crew: normalize from `n` (case/spacing/hyphen-collapsed) so "In House #4" and
  // "In-House #4" don't split into two rows; strip stray "T2 - " tech prefix; Title-Case for display.
  const base = n.replace(/^t\d+\s*[-–]\s*/i, "").trim();
  return base ? base.replace(/\b\w/g, (ch) => ch.toUpperCase()) : "Unassigned";
}
function normCrew(raw) {
  const label = canonTeam(raw);
  const id = "z-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return { id, label };
}

// Editable Installation fields surfaced to the Coordinator/Calendar/Projects editor (Zoho API
// names VERIFIED live). "Stage" is the stage field; VIP_Installation is read-only in Zoho.
// Installation_Team is a lookup ({id,name}).
const INSTALL_EDIT_FIELDS = [
  "Installation_Notes", "Roof_Notes", "AHJ_Specific_Install_Notes",
  "Stage", "Installation_Team",
  "Installation_Proposed_Date", "Installation_Confirmed_Date", "Installation_Start_Date",
  "Installation_Continuation_Date", "Installation_Complete_Date", "R_R_Completed_Date",
  "Number_of_Days_Needed", "Number_of_Days_Planned_for_Install_default_2",
  "Customer_Access_Granted", "Drone_No_Fly_Zone", "VIP_Installation", "Language_Preference",
];
// Build the editable-record shape from a raw Installation row (shared by mapInstall — so the editor
// loads synchronously from the feed — and by the ?dl= word-search lookup fallback).
function buildInstallRec(row) {
  const rec = {};
  for (const k of INSTALL_EDIT_FIELDS) {
    const v = row[k];
    if (k === "Installation_Team") rec[k] = (v && typeof v === "object") ? { id: String(v.id || ""), name: v.name || "" } : null;
    else rec[k] = (v === undefined ? null : v);
  }
  return rec;
}
// Feed field list = display/scope/file fields + every editable field (so the editor loads from the feed).
const INSTALL_FIELDS = ["Name", "Deal", "MSP_Upgrade_Required", "Battery_Type", "Permit_Package", "BOM"]
  .concat(INSTALL_EDIT_FIELDS).filter((v, i, a) => a.indexOf(v) === i).join(",");
// A Zoho file-upload field is an array of file objects; return the latest (newest-first).
function latestFile(field) {
  if (!Array.isArray(field)) return null;
  const files = field
    .map((f) => ({ aid: f.id, name: f.File_Name__s || "download", modified: f.Modified_Time__s || f.Created_Time__s || "" }))
    .filter((f) => f.aid)
    .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  return files[0] || null;
}
// A service ticket can have up to 3 scheduled visits (Scheduled_Visit_1/2/3), each with its own
// technician (Assigned_Technician / Assigned_Technician_Visit_2 / Assigned_Technician_Visit_3).
const SERVICE_FIELDS = "Service_Type1,Area_of_Service,Name,Scheduled_Visit_1,Assigned_Technician,Scheduled_Visit_2,Assigned_Technician_Visit_2,Scheduled_Visit_3,Assigned_Technician_Visit_3,Associated_Deal,Ticket_Status,Type_of_Service,Service_Description,Priority";

// Editable Service_Ticket fields surfaced to the Coordinator/Calendar editor. Ticket_Status is
// the "Stage". Type_of_Service (multiselect) + Assigned_Technician* (lookups) are read-only display;
// the per-visit Scheduled_Visit_N is writable (the editor targets the visit that was clicked).
const SERVICE_EDIT_FIELDS = [
  "Ticket_Status", "Priority", "Type_of_Service", "Service_Description",
  "Scheduled_Visit_1", "Assigned_Technician",
  "Scheduled_Visit_2", "Assigned_Technician_Visit_2",
  "Scheduled_Visit_3", "Assigned_Technician_Visit_3",
];
// Build the editable-record shape from a raw Service_Ticket row (shared by mapService — so the
// editor loads synchronously from the feed — and by the ?svc= single-record lookup fallback).
function buildServiceRec(row) {
  const rec = {};
  for (const k of SERVICE_EDIT_FIELDS) {
    const v = row[k];
    if (/^Assigned_Technician/.test(k)) rec[k] = (v && typeof v === "object") ? { id: String(v.id || ""), name: v.name || "" } : (v || null);
    else if (k === "Type_of_Service") rec[k] = Array.isArray(v) ? v : (v == null ? [] : [v]);
    else rec[k] = (v === undefined ? null : v);
  }
  return rec;
}

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
    installRec: buildInstallRec(r), // editable fields embedded so the install editor loads synchronously (no per-open token refresh)
  };
}

// Map ONE scheduled visit of a service ticket → a calendar job. `visitN` (1|2|3) picks the date +
// technician; visitDateField/visitTechField tell the editor which Zoho fields THIS card writes to
// (so rescheduling a "Visit 2" card never clobbers Visit 1).
function mapServiceVisit(r, todayISO, visitN, dt, tech) {
  const deal = parseDeal(lookup(r.Associated_Deal));
  const crew = normCrew(lookup(tech) || "Unassigned");
  const v = splitDT(dt);
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
  // A SERVICE ticket is MSP work when Service_Type1 says so (e.g. "(5) MSP/Electrical Work").
  // This is a different signal from an INSTALL's MSP_Upgrade_Required / MSP-coded deal name —
  // same precedent as the MSP filter in windmar-operations/api/zoho-bonuses.js.
  // TWO Zoho fields can say MSP, and the CRM labels are confusingly swapped:
  //   Area_of_Service  → labelled "Service Category" in the UI → value "(5) MSP"
  //   Service_Type1    → labelled "System Type"                → value "(5) MSP/Electrical Work"
  // Both mean MSP work dispatched as a service visit (service crews #1S/#2S/#3S), which is
  // what zoho-bonuses.js already pays on. NOT the same as an install's MSP_Upgrade_Required.
  // Only these explicit category fields count — deliberately NOT scope keywords, which is what
  // caused the 2026-07-27 "installs mislabeled as MSP" bug (see windmar-operations bugLog).
  const svcType1 = (r.Service_Type1 && typeof r.Service_Type1 === "object" ? r.Service_Type1.name : r.Service_Type1) || "";
  const svcArea = (r.Area_of_Service && typeof r.Area_of_Service === "object" ? r.Area_of_Service.name : r.Area_of_Service) || "";
  const isMsp = /\bmsp\b/i.test(String(svcType1)) || /\bmsp\b/i.test(String(svcArea));
  return {
    id: (deal.num ? `${deal.num} · ${r.Name}` : r.Name) + (visitN > 1 ? ` #${visitN}` : ""),
    recordId: r.id,           // real Zoho Service_Ticket record id (for editing/attachments)
    num: deal.num || r.Name,
    kind: "service",
    code: "S",
    priority: r.Priority || "",
    ticketNo: r.Name,
    visit: visitN,            // which of the up-to-3 visits this card represents
    visitDateField: visitN === 1 ? "Scheduled_Visit_1" : `Scheduled_Visit_${visitN}`,
    visitTechField: visitN === 1 ? "Assigned_Technician" : `Assigned_Technician_Visit_${visitN}`,
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
    msp: isMsp, // MSP service work, from Service_Type1
    phone: "",
    geo: null,
    scope: ((svc || "Service").replace(/\(\d+\)\s*/g, "").trim()) + (visitN > 1 ? ` · Visit ${visitN}` : ""),
    desc: (r.Service_Description || "").trim(), // full work-order description for the ticket
    svcRec: buildServiceRec(r), // editable fields embedded so the service editor loads synchronously (no per-open token refresh)
  };
}
// Fan a service ticket out into one calendar job PER populated scheduled visit (1/2/3).
export function expandServiceVisits(r, todayISO) {
  const out = [];
  [[1, r.Scheduled_Visit_1, r.Assigned_Technician],
   [2, r.Scheduled_Visit_2, r.Assigned_Technician_Visit_2],
   [3, r.Scheduled_Visit_3, r.Assigned_Technician_Visit_3]].forEach(function (spec) {
    if (spec[1]) out.push(mapServiceVisit(r, todayISO, spec[0], spec[1], spec[2]));
  });
  return out;
}
// Back-compat single-entry mapper (visit 1) — kept for any caller expecting one record per ticket.
export function mapService(r, todayISO) {
  return mapServiceVisit(r, todayISO, 1, r.Scheduled_Visit_1, r.Assigned_Technician);
}

// Look up a single DL's Installation record (word-search the Installation module) — a FALLBACK
// for the editor when the feed's embedded installRec is unavailable (e.g. a Projects deal not in
// the calendar/ready feeds). Returns recordId + installNotes (hover tip) + the full editable `rec`.
async function lookupDL(dl, token) {
  const flds = ["Deal"].concat(INSTALL_EDIT_FIELDS).filter((v, i, a) => a.indexOf(v) === i);
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
  const rec = pick ? buildInstallRec(pick) : null;
  return {
    installNotes: pick ? (pick.Installation_Notes || "").trim() : "",
    recordId: pick ? pick.id : "",
    count: rows.length,
    rec,
  };
}

// Fetch one Service_Ticket record by id and return its editable fields — a FALLBACK for the
// service editor when the feed's embedded svcRec is unavailable. Normally the client uses the
// svcRec embedded in the feed (no per-open token refresh). Returns { recordId, module, rec }.
async function lookupService(recordId, token) {
  const path = `Service_Ticket/${encodeURIComponent(recordId)}?fields=${encodeURIComponent(SERVICE_EDIT_FIELDS.join(","))}`;
  const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (r.status === 204) return { recordId: "", module: "Service_Ticket", rec: null, count: 0 };
  if (!r.ok) throw new Error(`Zoho Service_Ticket ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const row = ((await r.json()).data || [])[0] || null;
  if (!row) return { recordId: "", module: "Service_Ticket", rec: null, count: 0 };
  return { recordId: String(row.id), module: "Service_Ticket", rec: buildServiceRec(row), count: 1 };
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
  // Florida wall-clock date (handles EDT/EST) — the server runs in UTC, so iso(today) would
  // flip to "tomorrow" after ~8 PM local and mislabel today's jobs as past-due. Use FL time.
  const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  try {
    const token = await getAccessToken();
    const only = String(req.query.only || ""); // only=install → skip service tickets (Install Map's all-time pull)
    const [installs, services] = await Promise.all([
      only === "service" ? Promise.resolve([]) : searchAll("Installation", `(Installation_Start_Date:between:${from},${to})`, INSTALL_FIELDS, token),
      only === "install" ? Promise.resolve([]) : searchAll("Service_Ticket", `((Scheduled_Visit_1:between:${from}T00:00:00${TZ},${to}T23:59:59${TZ})or(Scheduled_Visit_2:between:${from}T00:00:00${TZ},${to}T23:59:59${TZ})or(Scheduled_Visit_3:between:${from}T00:00:00${TZ},${to}T23:59:59${TZ}))`, SERVICE_FIELDS, token),
    ]);
    const jobs = [
      ...installs.map((r) => mapInstall(r, todayISO)),
      // Each service ticket fans out into one job PER scheduled visit; keep only visits inside the window.
      ...services.flatMap((r) => expandServiceVisits(r, todayISO)).filter((j) => j.date && j.date >= from && j.date <= to),
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
