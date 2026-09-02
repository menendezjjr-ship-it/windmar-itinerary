// /api/zoho-ready.js — "Ready to Schedule" feed for the Coordinator tab.
// Unlike /api/zoho-jobs (which is date-windowed), these records usually have NO
// Installation_Start_Date / Scheduled_Visit yet, so we query them by STATUS:
//   Installation   Stage = ready/near-ready (see READY_INSTALL_STAGES)
//   Service_Ticket Ticket_Status starts with "3" (verified live: "3. Need Schedule")
//
// IMPORTANT (verified live 2026-07): WindMar does NOT reset an Installation's Stage
// when its Deal dies, so "Pending Schedule" alone is 100% STALE (all 85 attached to
// Closed-Lost deals). The genuine live pipeline sits mostly at "Permit Approved - *"
// (permit approved, pending roof/MSP/HOA/umbrella). So we query the whole pre-scheduled
// stage set and rely on the Deal-Stage filter (LIVE_DEAL_STAGES) to keep only live sales —
// that is the only reliable "is this a real, still-active job?" signal here.
// Both are mapped to the SAME job shape /api/zoho-jobs emits so the client can reuse
// jobType(), the Coordinator card, and coordDetailModal (editable Installation detail).
// Self-contained (CommonJS-safe: only export default + global fetch — no import.meta).
import { rememberGood, failoverBody } from "./_lastgood.js";

const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";

let cachedToken = null;
let tokenExpiry = 0;

function hasCreds() {
  return !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN);
}

async function getAccessToken(force) {
  if (!force && cachedToken && Date.now() < tokenExpiry) return cachedToken;
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
      const url = `${API_DOMAIN}/crm/${API_VERSION}/Deals?ids=${encodeURIComponent(chunk.join(","))}&fields=Stage`;
      let res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
      if (res.status === 401) { token = await getAccessToken(true); res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } }); }
      if (res.status === 204 || !res.ok) continue;
      const data = await res.json();
      (data.data || []).forEach((d) => { if (d && d.id) out[String(d.id)] = (d.Stage || "").trim(); });
    } catch (e) { /* keep going; unresolved deals are simply kept (don't over-filter) */ }
  }
  return out;
}
// The ONLY reliable "is this a real, still-active job?" signal is the Deal's Stage — WindMar
// never rewinds an Installation's Stage when a sale dies OR after it finishes, so the ready
// pool is full of stale records whose Deal is Closed-Lost (dead) or already past install
// (In Service / Complete / Post-Installation…). Keep an install ONLY if its Deal is in a live,
// not-yet-completed pipeline stage. (Verified live 2026-07 against the Deals Stage picklist.)
const LIVE_DEAL_STAGES = new Set([
  "Won (Signed)", "Signed - Pending Approval",
  "Pre-Engineering", "NTP", "Site Visit", "Engineering", "Permitting", "Install",
]);

// Installation Stages that mean "not yet on the calendar, coordinator should act on it."
// "Pending Schedule*" = fully ready; "Permit Approved - *" = permit approved, pending one
// blocker (roof/MSP/HOA/umbrella). Stale/dead sales among these are dropped by LIVE_DEAL_STAGES.
const READY_INSTALL_STAGES = [
  "Pending Schedule",
  "Pending Schedule - Batteries Needed",
  "Permit Approved - HOA is Pending",
  "Permit Approved - Pending Roof",
  "Permit Approved - Pending MSP",
  "Permit Approved - Pending Umbrella",
];
const READY_INSTALL_CRITERIA = "(" + READY_INSTALL_STAGES.map((s) => `(Stage:equals:${s})`).join("or") + ")";

// Run a paginated CRM search and return ALL matches (criteria/fields URL-encoded).
async function searchAll(module, criteria, fields, token) {
  const all = [];
  for (let page = 1; page <= 25; page++) {
    const path =
      `${encodeURIComponent(module)}/search?criteria=${encodeURIComponent(criteria)}` +
      `&fields=${encodeURIComponent(fields)}&per_page=200&page=${page}`;
    let res = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (res.status === 401) { // cached token was invalidated by Zoho → force-refresh + retry once
      token = await getAccessToken(true);
      res = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    }
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
  if (/crew #?1s|george rivera|leonardo torres/.test(n)) return "Crew #1S"; // George Rivera took over Crew #1S (Sept 2026); keep Leonardo for historical rows
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

// Editable Installation fields for the Coordinator/Calendar/Projects install editor (mirrors zoho-jobs.js).
const INSTALL_EDIT_FIELDS = [
  "Installation_Notes", "Roof_Notes", "AHJ_Specific_Install_Notes",
  "Stage", "Installation_Team",
  "Installation_Proposed_Date", "Installation_Confirmed_Date", "Installation_Start_Date",
  "Installation_Continuation_Date", "Installation_Complete_Date", "R_R_Completed_Date",
  "Number_of_Days_Needed", "Number_of_Days_Planned_for_Install_default_2",
  "Customer_Access_Granted", "Drone_No_Fly_Zone", "VIP_Installation", "Language_Preference",
];
function buildInstallRec(row) {
  const rec = {};
  for (const k of INSTALL_EDIT_FIELDS) {
    const v = row[k];
    if (k === "Installation_Team") rec[k] = (v && typeof v === "object") ? { id: String(v.id || ""), name: v.name || "" } : null;
    else rec[k] = (v === undefined ? null : v);
  }
  return rec;
}
const INSTALL_FIELDS = ["Name", "Deal", "MSP_Upgrade_Required", "Battery_Type"].concat(INSTALL_EDIT_FIELDS).filter((v, i, a) => a.indexOf(v) === i).join(",");
const SERVICE_FIELDS = "Service_Type1,Area_of_Service,Number_of_Reserved_Time_Blocks_1,Number_of_Reserved_Time_Blocks_2,Number_of_Reserved_Time_Blocks_3,Reserved_Block_Time_Visit_1,Reserved_Block_Time_Visit_2,Reserved_Block_Time_3,Name,Scheduled_Visit_1,Assigned_Technician,Associated_Deal,Ticket_Status,Type_of_Service,Service_Description,Priority";

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
    installRec: buildInstallRec(r), // editable fields embedded so the install editor loads synchronously
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
  // MSP service work is flagged by Service_Type1 ("(5) MSP/Electrical Work"), not by the
  // install-side MSP_Upgrade_Required. Mirrors zoho-jobs.js and zoho-bonuses.js.
  // Area_of_Service (UI label "Service Category") = "(5) MSP"; Service_Type1 (UI label
  // "System Type") = "(5) MSP/Electrical Work". Either marks MSP work done on a service visit.
  // Explicit category fields only — scope-keyword matching caused a past mislabeling bug.
  const svcType1 = (r.Service_Type1 && typeof r.Service_Type1 === "object" ? r.Service_Type1.name : r.Service_Type1) || "";
  const svcArea = (r.Area_of_Service && typeof r.Area_of_Service === "object" ? r.Area_of_Service.name : r.Area_of_Service) || "";
  const isMsp = /\bmsp\b/i.test(String(svcType1)) || /\bmsp\b/i.test(String(svcArea));
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
    msp: isMsp, // MSP service work, from Service_Type1 / Area_of_Service
    // 2-hour reserved blocks for visit 1 (this feed is pre-schedule, so only visit 1 applies).
    blocks: Math.max(0, Number(r.Number_of_Reserved_Time_Blocks_1) || 0),
    hours: Math.max(0, Number(r.Number_of_Reserved_Time_Blocks_1) || 0) * 2,
    blockWindow: (function(){ var w=String((r.Reserved_Block_Time_Visit_1 && typeof r.Reserved_Block_Time_Visit_1==="object" ? r.Reserved_Block_Time_Visit_1.name : r.Reserved_Block_Time_Visit_1)||"").trim(); return /^-?\s*none\s*-?$/i.test(w)?"":w; })(),
    phone: "",
    geo: null,
    scope: (svc || "Service").replace(/\(\d+\)\s*/g, "").trim(),
    desc: (r.Service_Description || "").trim(),
    svcRec: buildServiceRec(r), // editable fields embedded so the service editor loads synchronously
    ready: true,
  };
}

// ── COORDINATION READY (reflects the Zoho "Coordination Trigger" report) ────────────────────────
// Deals in the coordination phase — Stage Engineering or Permitting — whose ENGINEERING/plans are
// Complete (digital plans uploaded / printed & mailed) or In Process. These are the jobs a
// coordinator should act on next (push permit → schedule). Engineering_Stage is free-text, so we
// fetch the two stages and filter it in code. Shown as its own Coordinator section.
const COORD_CRITERIA = "((Stage:equals:NTP)or(Stage:equals:Engineering)or(Stage:equals:Permitting)or(Stage:equals:Install))";
const COORD_FIELDS = "Deal_Name,Stage,Engineering_Stage,FDA_Status,Address,City,State,Zip,Client_Phone,Client_Mobile,System_Size_kW1,Authority_Having_Jurisdiction_AHJ,County1,Post_Install_QA_Stage,Project_Coordinator,Module_Count";
// EXACT report filter (Zoho "Coordination Trigger" report): the Final Design is APPROVED —
// FDA_Status = "Signed and Approved - Complete" OR "No response in 24 hrs, approved" — and the job
// has an engineering stage. This is what narrows the section to the report's jobs (not every
// Engineering/Permitting deal). FDA_Status is free-text, so we fetch by Stage and filter in code.
const COORD_FDA_RX = /signed and approved|no response in 24/i;
const cclean = (s) => String(s || "").replace(/[\s,]+$/, "").trim();
function mapCoordinationDeal(d) {
  const p = parseDeal(d.Deal_Name);
  const address = [cclean(d.Address), cclean(d.City), [cclean(d.State), cclean(d.Zip)].filter(Boolean).join(" ")].filter(Boolean).join(", ") || p.address || "";
  const coord = lookup(d.Project_Coordinator) || "";
  return {
    id: p.num || d.id, recordId: d.id, dealId: d.id, num: p.num || "",
    kind: "coordination", code: p.code || "DL",
    project: p.customer || d.Deal_Name || "", address,
    crew: "z-coordination", crewLabel: coord || "Coordination",
    date: null, status: "ready", cat: "coordination",
    stage: d.Stage || "", dealStage: d.Stage || "",
    engStage: cclean(d.Engineering_Stage), fdaStatus: cclean(d.FDA_Status), qaStage: cclean(d.Post_Install_QA_Stage), coordinator: coord,
    systemKw: (d.System_Size_kW1 != null && d.System_Size_kW1 !== 0) ? d.System_Size_kW1 : null,
    ahj: lookup(d.Authority_Having_Jurisdiction_AHJ) || "", county: d.County1 || "",
    msp: false, phone: cclean(d.Client_Phone) || cclean(d.Client_Mobile) || "", geo: null,
    scope: cclean(d.Engineering_Stage) || "Coordination",
    zohoUrl: `https://crm.zoho.com/crm/org666151142/tab/Potentials/${d.id}`,
    ready: true,
  };
}

// ── Pre-Engineering ───────────────────────────────────────────────────────────────────────
// Deals sitting at Stage "Pre-Engineering" — the step BEFORE the Coordination-Ready set (which
// starts at NTP/Engineering). Mirrors the Zoho "Pre-Engineering" report so a coordinator can work
// the queue by area from inside the Itinerary instead of in the CRM.
// Same record shape as mapCoordinationDeal, so it inherits the area/route view for free.
const PREENG_CRITERIA = "(Stage:equals:Pre-Engineering)";
function mapPreEngDeal(d) {
  const p = parseDeal(d.Deal_Name);
  // State and Zip join with a SPACE ("FL 34743"), matching mapCoordinationDeal — a comma there
  // is not a standard US address and geocodes worse.
  const address = [cclean(d.Address), cclean(d.City), [cclean(d.State), cclean(d.Zip)].filter(Boolean).join(" ")].filter(Boolean).join(", ") || p.address || "";
  const coord = lookup(d.Project_Coordinator) || "";
  return {
    id: p.num || d.id, recordId: d.id, dealId: d.id, num: p.num || "",
    kind: "preeng", code: p.code || "DL",
    project: p.customer || d.Deal_Name || "", address,
    crew: "z-preeng", crewLabel: coord || "Pre-Engineering",
    date: null, status: "ready", cat: "preeng",
    stage: d.Stage || "", dealStage: d.Stage || "",
    engStage: cclean(d.Engineering_Stage), fdaStatus: cclean(d.FDA_Status), coordinator: coord,
    systemKw: (d.System_Size_kW1 != null && d.System_Size_kW1 !== 0) ? d.System_Size_kW1 : null,
    ahj: lookup(d.Authority_Having_Jurisdiction_AHJ) || "", county: d.County1 || "",
    msp: false, phone: cclean(d.Client_Phone) || cclean(d.Client_Mobile) || "", geo: null,
    scope: cclean(d.Engineering_Stage) || "Pre-Engineering",
    zohoUrl: `https://crm.zoho.com/crm/org666151142/tab/Potentials/${d.id}`,
    ready: true,
  };
}

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=300");
  if (!hasCreds()) return res.status(200).json({ configured: false, ok: false, jobs: [] });

  const todayISO = new Date().toISOString().slice(0, 10);
  try {
    const token = await getAccessToken();
    const [installs, services, coordDeals, preEngDeals] = await Promise.all([
      searchAll("Installation", READY_INSTALL_CRITERIA, INSTALL_FIELDS, token),
      // starts_with:3 captures "3. Need Schedule" (+ any 3.x variant); mapper keeps only needs_schedule.
      searchAll("Service_Ticket", "(Ticket_Status:starts_with:3)", SERVICE_FIELDS, token),
      // Coordination-ready = Deals at Engineering/Permitting with plans complete / engineering in process.
      searchAll("Deals", COORD_CRITERIA, COORD_FIELDS, token),
      // Pre-Engineering = the queue one step earlier. No FDA/engineering-stage filter: at this
      // point the design has not been produced yet, so those fields are legitimately empty.
      searchAll("Deals", PREENG_CRITERIA, COORD_FIELDS, token),
    ]);

    const instJobsRaw = installs.map(mapReadyInstall);

    // Keep only installs whose associated Deal is a LIVE, not-yet-completed project.
    // Batch-resolve the Deal Stages, then filter. An install whose Deal can't be resolved
    // (empty stage) is KEPT (fail-open) so a transient deal-fetch hiccup never hides real jobs.
    const dealStages = await fetchDealStages(instJobsRaw.map((j) => j.dealId), token);
    const instJobs = [];
    let filteredStale = 0;
    for (const j of instJobsRaw) {
      const st = j.dealId ? (dealStages[j.dealId] || "") : "";
      j.dealStage = st;
      if (st && !LIVE_DEAL_STAGES.has(st)) { filteredStale++; continue; }
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

    // Coordination-ready Deals → their own section (kept separate from the schedule list; a DL can be
    // in coordination AND have a ready install, so we don't dedupe these against the above).
    const coordJobs = coordDeals.map(mapCoordinationDeal).filter((j) => COORD_FDA_RX.test(j.fdaStatus) && j.engStage);
    jobs.push(...coordJobs);
    const preEngJobs = preEngDeals.map(mapPreEngDeal);
    jobs.push(...preEngJobs);

    const payload = {
      configured: true,
      ok: true,
      updated: new Date().toISOString(),
      counts: { installs: instJobs.length, services: svcJobs.length, coordination: coordJobs.length, preeng: preEngJobs.length, jobs: jobs.length, filteredStale },
      jobs,
    };
    rememberGood("ready", payload);
    return res.status(200).json(payload);
  } catch (e) {
    const fo = failoverBody("ready", e && e.message || e, { jobs: [] });
    res.setHeader("Cache-Control", fo.cache);
    return res.status(200).json(fo.body);
  }
}
