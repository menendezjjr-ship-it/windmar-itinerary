// /api/zoho-ready.js — "Ready to Schedule" feed for the Coordinator tab.
// Unlike /api/zoho-jobs (which is date-windowed), these records usually have NO
// Installation_Start_Date / Scheduled_Visit yet, so we query them by STATUS:
//   Installation   Stage = "Pending Schedule" OR "Pending Schedule - Batteries Needed"
//   Service_Ticket Ticket_Status starts with "3" (verified live: "3. Need Schedule")
// Both are mapped to the SAME job shape /api/zoho-jobs emits so the client can reuse
// jobType(), the Coordinator card, and coordDetailModal (editable Installation detail).
// Self-contained (CommonJS-safe: only export default + global fetch — no import.meta).

const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";

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

// Fetch { dealId: Stage } for a set of Deal ids (chunked ≤100/call via the bulk-by-ids GET).
// Used to drop installs whose SALE is dead (Deal Stage "Closed Lost") even though the
// Installation is still "Pending Schedule". Never throws — on error returns what it has.
async function fetchDealStages(ids, token) {
  const out = {};
  const uniq = [...new Set((ids || []).filter(Boolean).map(String))];
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    try {
      const res = await fetch(
        `${API_DOMAIN}/crm/${API_VERSION}/Deals?ids=${encodeURIComponent(chunk.join(","))}&fields=Stage`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
      );
      if (res.status === 204 || !res.ok) continue;
      const data = await res.json();
      (data.data || []).forEach((d) => { if (d && d.id) out[String(d.id)] = (d.Stage || "").trim(); });
    } catch (e) { /* keep going; unresolved deals are simply kept (don't over-filter) */ }
  }
  return out;
}
const DEAD_STAGE = /closed\s*lost|dead|cancell?ed/i; // primarily "Closed Lost" (verified exact string live)

// Run a paginated CRM search and return ALL matches (criteria/fields URL-encoded).
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
  const a = rest.match(/^(.+?)[\s,]+(\d{1,6}[\s,].+)$/);
  if (a) { out.customer = a[1].replace(/[\s,]+$/, "").trim(); out.address = a[2].trim(); }
  else { out.customer = rest; }
  return out;
}

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

// Canonicalize a Zoho crew/team/tech label (mirrors api/zoho-jobs.js).
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
  return s.replace(/^t\d+\s*[-–]\s*/i, "").trim() || "Unassigned";
}
function normCrew(raw) {
  const label = canonTeam(raw);
  const id = "z-" + label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return { id, label };
}

const INSTALL_FIELDS = "Name,Stage,Installation_Team,Deal,MSP_Upgrade_Required,Battery_Type,Number_of_Days_Needed,Installation_Notes,Installation_Start_Date";
const SERVICE_FIELDS = "Name,Scheduled_Visit_1,Assigned_Technician,Associated_Deal,Ticket_Status,Type_of_Service,Service_Description,Priority";

// Editable Service_Ticket fields for the Coordinator/Calendar service editor (mirrors zoho-jobs.js).
const SERVICE_EDIT_FIELDS = ["Ticket_Status", "Priority", "Type_of_Service", "Service_Description", "Scheduled_Visit_1", "Assigned_Technician"];
function buildServiceRec(row) {
  const rec = {};
  for (const k of SERVICE_EDIT_FIELDS) {
    const v = row[k];
    if (k === "Assigned_Technician") rec[k] = (v && typeof v === "object") ? { id: String(v.id || ""), name: v.name || "" } : (v || null);
    else if (k === "Type_of_Service") rec[k] = Array.isArray(v) ? v : (v == null ? [] : [v]);
    else rec[k] = (v === undefined ? null : v);
  }
  return rec;
}

// Map a "Pending Schedule" Installation -> the shared job shape (kind:"install").
function mapReadyInstall(r) {
  const deal = parseDeal(lookup(r.Deal));
  const crew = normCrew(lookup(r.Installation_Team) || "Unassigned");
  const msp = r.MSP_Upgrade_Required === "MSP" || r.MSP_Upgrade_Required === true;
  const scopeBits = [];
  if (r.Battery_Type) scopeBits.push(lookup(r.Battery_Type));
  if (msp) scopeBits.push("MSP upgrade");
  if (r.Number_of_Days_Needed) scopeBits.push(`${r.Number_of_Days_Needed}-day`);
  return {
    id: deal.num || r.Name,
    recordId: r.id,
    dealId: (r.Deal && r.Deal.id) || "", // associated Deal id → used to drop Closed-Lost sales
    num: deal.num || "",
    kind: "install",
    code: deal.code || "DL",
    project: deal.customer || r.Name,
    address: deal.address || "",
    crew: crew.id,
    crewLabel: crew.label,
    date: r.Installation_Start_Date || null,
    status: "ready",
    cat: "needs_schedule",
    stage: (r.Stage || "").trim(),
    msp,
    phone: "",
    geo: null,
    scope: scopeBits.join(" · ") || "Installation",
    installNotes: (r.Installation_Notes || "").trim(),
    ready: true,
  };
}

// Map a needs-to-schedule Service_Ticket -> the shared job shape (kind:"service").
// Returns cat so the handler can keep only genuine needs_schedule tickets.
function mapReadyService(r, todayISO) {
  const deal = parseDeal(lookup(r.Associated_Deal));
  const crew = normCrew(lookup(r.Assigned_Technician) || "Unassigned");
  const v = splitDT(r.Scheduled_Visit_1);
  const st = (r.Ticket_Status || "").trim();
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
    recordId: r.id,
    ticketNo: r.Name,
    num: deal.num || r.Name,
    kind: "service",
    code: "S",
    priority: r.Priority || "",
    project: deal.customer || r.Name,
    address: deal.address || "",
    crew: crew.id,
    crewLabel: crew.label,
    date: v.date,
    window: v.time || "Time TBD",
    status: "ready",
    cat,
    stage: st,
    rawStatus: st,
    msp: false,
    phone: "",
    geo: null,
    scope: (svc || "Service").replace(/\(\d+\)\s*/g, "").trim(),
    desc: (r.Service_Description || "").trim(),
    svcRec: buildServiceRec(r), // editable fields embedded so the service editor loads synchronously
    ready: true,
  };
}

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
  if (!hasCreds()) return res.status(200).json({ configured: false, ok: false, jobs: [] });

  const todayISO = new Date().toISOString().slice(0, 10);
  try {
    const token = await getAccessToken();
    const [installs, services] = await Promise.all([
      searchAll(
        "Installation",
        "((Stage:equals:Pending Schedule)or(Stage:equals:Pending Schedule - Batteries Needed))",
        INSTALL_FIELDS,
        token
      ),
      // starts_with:3 captures "3. Need Schedule" (+ any 3.x variant); mapper keeps only needs_schedule.
      searchAll("Service_Ticket", "(Ticket_Status:starts_with:3)", SERVICE_FIELDS, token),
    ]);

    const instJobsRaw = installs.map(mapReadyInstall);

    // Drop installs whose associated Deal (the sale) is dead — primarily Stage "Closed Lost".
    // Batch-resolve the Deal Stages, then filter. Installs with no resolvable Deal are KEPT.
    const dealStages = await fetchDealStages(instJobsRaw.map((j) => j.dealId), token);
    const instJobs = [];
    let closedLost = 0;
    for (const j of instJobsRaw) {
      const st = j.dealId ? dealStages[j.dealId] : "";
      if (st && DEAD_STAGE.test(st)) { closedLost++; continue; }
      instJobs.push(j);
    }

    const svcJobs = services
      .map((r) => mapReadyService(r, todayISO))
      .filter((j) => j.cat === "needs_schedule");

    // Dedupe by num (installs win on collision).
    const seen = new Set();
    const jobs = [];
    for (const j of [...instJobs, ...svcJobs]) {
      const key = String(j.num || j.id).toUpperCase().replace(/\s+/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(j);
    }

    return res.status(200).json({
      configured: true,
      ok: true,
      updated: new Date().toISOString(),
      counts: { installs: instJobs.length, services: svcJobs.length, jobs: jobs.length, filteredClosedLost: closedLost },
      jobs,
    });
  } catch (e) {
    return res.status(200).json({ configured: true, ok: false, error: String(e && e.message || e), jobs: [] });
  }
}
