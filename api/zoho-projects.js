// /api/zoho-projects.js — LIVE project pipeline for the coordinator.
// Pulls Zoho CRM Deals across the operational lifecycle (NTP → Post-Installation)
// with full status, homeowner contact, system specs and a dated stage timeline.
// Secrets live ONLY in env vars (ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN).

const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";

// Ordered operational pipeline the coordinator works (NTP → post-install).
export const STAGES = ["NTP", "Site Visit", "Engineering", "Permitting", "Install", "Post-Installation"];
const STAGE_IDX = Object.fromEntries(STAGES.map((s, i) => [s, i]));

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

async function searchAll(module, criteria, fields, token) {
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const path = `${encodeURIComponent(module)}/search?criteria=${encodeURIComponent(criteria)}&fields=${encodeURIComponent(fields)}&per_page=200&page=${page}`;
    const res = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (res.status === 204) break;
    if (!res.ok) throw new Error(`Zoho ${module} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const batch = data.data || [];
    all.push(...batch);
    if (batch.length < 200 || !(data.info && data.info.more_records)) break;
  }
  return all;
}

const lookup = (v) => (v && typeof v === "object" ? v.name : v) || "";
const clean = (s) => String(s || "").replace(/[\s,]+$/, "").trim();

function fmtPhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === "1") return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return s || "";
}

// "DL8649 ROSARITO GÓMEZ COLLAZO 8200 Mara Vista Court, Orlando, FL" -> code/num/customer
function parseDeal(name) {
  const out = { code: "", num: "", customer: "" };
  if (!name) return out;
  const m = name.match(/^\s*((?:RDL|RL|DL|MSP|S)\d{2,})\s+(.*)$/i);
  if (!m) { out.customer = name.trim(); return out; }
  out.num = m[1].toUpperCase();
  out.code = (out.num.match(/^(RDL|RL|DL|MSP|S)/) || [])[1] || "";
  const rest = m[2].trim();
  const a = rest.match(/^(.+?)[\s,]+\d{1,6}[\s,].+$/);
  out.customer = a ? a[1].replace(/[\s,]+$/, "").trim() : rest;
  return out;
}

// Normalize one inspection's status from its text + dates.
function inspOne(stext, sched, appr, inWindow, vip) {
  stext = (stext || "").trim();
  let status = "none", label = "";
  if (appr || /approv|pass/i.test(stext)) { status = "approved"; label = stext || "Approved"; }
  else if (/pending|revision|hold|fail|denied/i.test(stext)) { status = "pending"; label = stext; }
  else if (sched || /scheduled/i.test(stext)) { status = "scheduled"; label = stext || "Scheduled"; }
  else if (/ready to schedule/i.test(stext)) { status = "ready"; label = stext; }
  else if (stext) { status = "pending"; label = stext; }
  else if (inWindow) { status = "missing"; label = "Not scheduled"; }
  else if (vip) { status = "missing"; label = "VIP — not scheduled"; }
  return { status, label, scheduled: sched || null, approved: appr || null };
}
// Build typed inspection entries (final/electrical vs roofing) for a deal.
function inspStatus(r) {
  const code = ((r.Deal_Name || "").match(/^\s*(RDL|RL|DL|MSP|S)/i) || [, "DL"])[1].toUpperCase();
  const inWindow = r.Stage === "Install" || r.Stage === "Post-Installation";
  const vip = r.VIP_Customer === true;
  const isVip = vip || /\bvip\b/i.test(r.Inspection_Stage || "");
  const items = [];
  // Final / electrical inspection (solar/battery/MSP/service). VIP → its own type.
  if (code === "DL" || code === "RDL" || code === "MSP" || code === "S") {
    const f = inspOne(r.Inspection_Stage, r.Final_Inspection_Scheduled_Date, r.Final_Inspection_Approved, inWindow, isVip);
    if (f.status !== "none") items.push({ type: isVip ? "vip" : "final", vip: isVip, ...f });
  }
  // Roofing inspection
  if (code === "RL" || code === "RDL") {
    const rf = inspOne("", r.Roofing_Final_Inspection_Scheduled_Date, r.Roofing_Final_Inspection_Approved_Date, inWindow, false);
    if (rf.status !== "none") items.push({ type: "roofing", vip: isVip, ...rf });
  }
  if (!items.length && isVip) items.push({ type: "vip", vip: true, status: "missing", label: "VIP — not scheduled", scheduled: null, approved: null });
  const rank = { missing: 0, ready: 1, pending: 2, scheduled: 3, approved: 4 };
  let worst = "none"; items.forEach((it) => { if (worst === "none" || rank[it.status] < rank[worst]) worst = it.status; });
  return { items, isItem: items.length > 0, status: worst, vip };
}
export function mapDeal(r) {
  const d = parseDeal(r.Deal_Name);
  const addr = [clean(r.Address), clean(r.City), [clean(r.State), clean(r.Zip)].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  // Curated stage timeline (label + date) in lifecycle order; nulls shown as pending client-side.
  const timeline = [
    { key: "ntp", label: "NTP", date: r.NTP_From || null },
    { key: "survey", label: "Site Survey", date: r.Site_Survey_Completed_Date || r.Site_Survey_Scheduled_Date || null },
    { key: "engineering", label: "Engineering", date: r.Design_Engineering_From ? String(r.Design_Engineering_From).slice(0, 10) : null },
    { key: "permit_sub", label: "Permit Submitted", date: r.Permit_Submitted_Date || null },
    { key: "permit_rec", label: "Permit Received", date: r.Permit_Received_Date || null },
    { key: "install", label: "Install", date: (r.Install_From ? String(r.Install_From).slice(0, 10) : null) || r.Installation_Completed_Date || null },
    { key: "inspection", label: "Final Inspection", date: r.Final_Inspection_Approved || r.Final_Inspection_Scheduled_Date || null },
    { key: "pto", label: "PTO / Utility", date: r.PTO_Approval_Date || null },
  ];
  const battery = lookup(r.Battery_Brand) || (r.Tesla_Powerwall_Quantity ? lookup(r.Tesla_Powerwall_Quantity) : "");
  return {
    id: r.id,
    num: d.num || "",
    code: d.code || "DL",
    name: d.customer || r.Deal_Name || "",
    stage: r.Stage,
    stageIdx: STAGE_IDX[r.Stage] != null ? STAGE_IDX[r.Stage] : 99,
    phone: fmtPhone(r.Client_Phone),
    mobile: fmtPhone(r.Client_Mobile),
    email: r.Client_Email || "",
    contact: lookup(r.Contact_Name) || "",
    owner: lookup(r.Owner) || "",
    address: addr,
    systemKw: (r.System_Size_kW1 != null && r.System_Size_kW1 !== 0) ? r.System_Size_kW1 : null,
    modules: r.Module_Count || null,
    moduleW: lookup(r.Module_Wattage) || null,
    battery: battery || null,
    finance: lookup(r.Primary_Finance_Company) || "",
    financeNotes: r.Finance_Notes || "",
    financeCustNo: r.Finance_Company_Customer_Number || "",
    secondaryFinance: r.Secondary_Finance_Required === true || r.Secondary_Finance_Required === "true",
    amount: (r.Amount != null) ? r.Amount : null,
    salesRep: lookup(r.Owner) || "",
    ahj: lookup(r.Authority_Having_Jurisdiction_AHJ) || "",
    hoa: lookup(r.Is_there_an_HOA) || (r.HOA ? "Yes" : ""),
    roofType: lookup(r.Roof_Type) || "",
    reroof: lookup(r.Windmar_Roofing) || "",
    modified: r.Modified_Time || null,
    stageModified: r.Stage_Modified_Time || null,
    insp: inspStatus(r),
    timeline,
  };
}

const FIELDS = [
  "Deal_Name", "Stage", "Modified_Time", "Stage_Modified_Time",
  "Client_Phone", "Client_Mobile", "Client_Email", "Contact_Name", "Owner",
  "Address", "City", "State", "Zip",
  "System_Size_kW1", "Module_Count", "Module_Wattage", "Battery_Brand", "Tesla_Powerwall_Quantity",
  "Primary_Finance_Company", "Finance_Notes", "Finance_Company_Customer_Number", "Secondary_Finance_Required", "Amount",
  "Authority_Having_Jurisdiction_AHJ", "Is_there_an_HOA", "HOA", "Roof_Type", "Windmar_Roofing",
  "NTP_From", "Site_Survey_Scheduled_Date", "Site_Survey_Completed_Date", "Design_Engineering_From",
  "Permit_Submitted_Date", "Permit_Received_Date", "Install_From", "Installation_Completed_Date",
  "Final_Inspection_Scheduled_Date", "Final_Inspection_Approved", "Final_Inspection_Reschedule",
  "Inspection_Stage", "VIP_Customer", "Roofing_Final_Inspection_Scheduled_Date", "Roofing_Final_Inspection_Approved_Date",
  "PTO_Approval_Date",
].join(",");

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
  if (!hasCreds()) return res.status(200).json({ configured: false, ok: false, stages: STAGES, projects: [] });
  try {
    const token = await getAccessToken();
    const criteria = "(" + STAGES.map((s) => `(Stage:equals:${s})`).join("or") + ")";
    const deals = await searchAll("Deals", criteria, FIELDS, token);
    const projects = deals.map(mapDeal).sort((a, b) => a.stageIdx - b.stageIdx || String(a.num).localeCompare(String(b.num)));
    const byStage = {};
    STAGES.forEach((s) => (byStage[s] = 0));
    projects.forEach((p) => { if (byStage[p.stage] != null) byStage[p.stage]++; });
    return res.status(200).json({
      configured: true, ok: true, updated: new Date().toISOString(),
      stages: STAGES, counts: { total: projects.length, byStage }, projects,
    });
  } catch (e) {
    return res.status(200).json({ configured: true, ok: false, error: String(e && e.message || e), stages: STAGES, projects: [] });
  }
}
