// /api/assistant.js — "Sunny", the WindMar Itinerary READ-ONLY AI assistant.
//
// Contract:
//   POST { messages: [{role:"user"|"assistant", content:"..."}], lang?: "en"|"es" }
//   ->  200 { ok:true, answer:"<text>", used:["tool",...] }              on success
//       200 { ok:false, error:"..." }                                     on any failure
//   OPTIONS -> 200 (CORS preflight). Never throws an unhandled 500 — everything is wrapped.
//
// Sunny answers coordinator/crew questions about WindMar solar/roofing PROJECTS (live Zoho CRM +
// SiteCapture, READ-ONLY) AND NEC/electrical/equipment questions. The itinerary has no AI key, so
// the "brain" is the Field HUB's NEC Assistant (Gemini) at NEC_AI_URL — we send it the question +
// history + lang + a knowledgeContext string we build from the READ-ONLY Zoho/SiteCapture lookups.
// It NEVER edits/schedules anything.
//
// Env vars:
//   NEC_AI_URL         (optional)  — default the Field HUB nec-ai endpoint (the AI brain; its key lives there)
//   ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN  (required for Zoho tools)
//   ZOHO_ACCOUNTS_HOST (optional, default https://accounts.zoho.com)
//   ZOHO_API_DOMAIN    (optional, default https://www.zohoapis.com)
//   ZOHO_API_VERSION   (optional, default v8)
//   SITECAPTURE_USER/PASS or Site_Capture_Key, SITECAPTURE_PROXY (optional) — SiteCapture search

const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";
const ORG = "org666151142";
const SC_PROXY = process.env.SITECAPTURE_PROXY || "https://windmar-service-app.vercel.app/api/sitecapture";
const SC_FIXED = process.env.SITECAPTURE_API_KEY || "zapier-api-4320";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ASSISTANT_MODEL || "claude-haiku-4-5-20251001"; // fast+cheap for chat; override via env

export const config = { maxDuration: 60 };

// ---- shared helpers ---------------------------------------------------------

let cachedToken = null, tokenExpiry = 0;
function hasZoho() { return !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN); }

// fetch with a hard AbortController timeout so a slow upstream fails fast (returns null on error/timeout).
async function fetchT(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms || 12000);
  try { return await fetch(url, Object.assign({}, opts, { signal: c.signal })); }
  catch (e) { return null; }
  finally { clearTimeout(t); }
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetchT(`${ACCOUNTS_HOST}/oauth/v2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET, refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    }),
  }, 12000);
  if (!res) throw new Error("Zoho token request timed out");
  const data = await res.json();
  if (!data.access_token) throw new Error(`token refresh failed: ${data.error || JSON.stringify(data)}`);
  cachedToken = data.access_token; tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// One Zoho CRM search page (criteria OR word). Returns [] on 204/error rather than throwing.
async function zohoSearch(module, params, token) {
  const path = `${encodeURIComponent(module)}/search?${params}`;
  const r = await fetchT(`${API_DOMAIN}/crm/${API_VERSION}/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } }, 12000);
  if (!r) throw new Error(`Zoho ${module} timed out`);
  if (r.status === 204) return [];
  if (!r.ok) throw new Error(`Zoho ${module} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).data || [];
}

const lookup = (v) => (v && typeof v === "object" ? v.name : v) || "";
const clean = (s) => String(s || "").replace(/[\s,]+$/, "").trim();
const todayISO = () => new Date().toISOString().slice(0, 10);

// "DL8467 Frank Roman 7420 Olin Way Orlando FL" -> { code, num, customer, address }
function parseDeal(name) {
  const out = { code: "", num: "", customer: "", address: "" };
  if (!name) return out;
  const m = name.match(/^\s*((?:RDL|RL|DL|MSP|S)\d{2,})\s+(.*)$/i);
  if (!m) { out.customer = String(name).trim(); return out; }
  out.num = m[1].toUpperCase();
  out.code = (out.num.match(/^(RDL|RL|DL|MSP|S)/) || [])[1] || "";
  const rest = m[2].trim();
  const a = rest.match(/^(.+?)[\s,]+(\d{1,6}[\s,].+)$/);
  if (a) { out.customer = a[1].replace(/[\s,]+$/, "").trim(); out.address = a[2].trim(); }
  else { out.customer = rest; }
  return out;
}

// Normalize a DL-ish token: "dl 8765" / "DL8765" -> "DL8765".
function normDL(s) {
  const m = String(s || "").toUpperCase().replace(/\s+/g, "").match(/((?:RDL|RL|DL|MSP|S)\d{2,})/);
  return m ? m[1] : String(s || "").toUpperCase().replace(/\s+/g, "");
}

// Canonicalize a Zoho crew/team label to the official roster name (mirrors zoho-jobs / zoho-ready).
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

// Strip Zoho note HTML + @-mention tokens (crm[user#...]crm) into plain text.
function stripHtml(s) {
  return String(s || "")
    .replace(/crm\[user#[^\]]*\]crm/g, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#?\w+;/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// All CRM Notes attached to a record (module/id) → [{title,content,author,time}], newest first.
async function fetchNotes(module, id, token) {
  if (!id) return [];
  const r = await fetchT(`${API_DOMAIN}/crm/${API_VERSION}/${encodeURIComponent(module)}/${encodeURIComponent(id)}/Notes?fields=Note_Title,Note_Content,Created_Time,Owner&per_page=50&sort_by=Created_Time&sort_order=desc`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }, 12000).catch(() => null);
  if (!r || r.status === 204 || !r.ok) return [];
  const d = await r.json().catch(() => ({}));
  return (d.data || []).map((n) => ({ title: n.Note_Title || "", content: stripHtml(n.Note_Content), author: (n.Owner && n.Owner.name) || "", time: n.Created_Time || "" }))
    .filter((n) => n.content || n.title);
}

// Stopwords so "what's the status of the Martinez install?" → "martinez install" for Zoho word-search.
const STOP = new Set(("what whats what s is are am the a an of on for from me my mine show tell about job jobs project projects please who whom where when why how does do did can could would should you your check checking look looking see find finding get getting give any all this that these those it its with to in into and or at as by not no now today " +
  "info information detail details note notes report reports status update updates state stage schedule scheduled " +
  "going happening up gonna wrong need needs also just still onto here there thing things something anything going-on " +
  "que cual cuales es esta este esto los las el la del de en para me mi por favor quien donde cuando como puede podria buscar encontrar dame muestra dime sobre trabajo trabajos proyecto proyectos info nota notas reporte reportes estado etapa informacion detalle detalles").split(/\s+/));
function searchTermsFrom(text) {
  const toks = String(text || "").toLowerCase().replace(/[^\w\s#/-]/g, " ").split(/\s+/).filter(Boolean);
  return toks.filter((t) => t.length >= 2 && !STOP.has(t) && !GENERIC.has(t)).join(" ").trim();
}

// Zoho word-search ANDs every word, so a full sentence rarely matches. Build ordered query
// candidates (proper nouns first, then each significant token) and return the FIRST that hits.
// Generic domain words that must NOT trigger a project search on their own (they'd match hundreds
// of records) — a real project reference has a NAME, address number, or DL.
const GENERIC = new Set(("installation install installing service schedule scheduled stage stages status statuses project projects job jobs inspection inspections permit permits deal deals note notes report reports crew crews calendar coordinator near each other pending complete ready today tomorrow week need needs want how what where when who "
  // equipment / brands / technical terms — must NOT trigger a customer/project NAME search
  + "tesla powerwall powerwalls solaredge qcells hanwha generac pwrcell enphase eaton siemens square gateway inverter inverters battery batteries solar roof roofing panel panels breaker breakers wire wiring conductor nec code florida owens corning snapnrack ironridge unirac msp gfci afci circuit amp amps volt volts kw ev charger meter diagram show "
  // schema / meta words — a question ABOUT Zoho/the data model must NOT search for a customer
  + "zoho crm module modules track tracking picklist pipeline lifecycle schema field fields record records name final list listing category categories type types").split(/\s+/));
async function smartProjectSearch(text) {
  const cands = [];
  // Proper-noun tokens must have a lowercase tail (a real name/word), so technical ACRONYMS like
  // EGC/MSP/AFCI/GFCI/NEC/AHJ are NOT treated as a customer name to search for.
  const caps = (String(text).match(/\b[A-Z][a-z]{2,}\b/g) || []).filter((w) => !STOP.has(w.toLowerCase()) && !GENERIC.has(w.toLowerCase()));
  if (caps.length > 1) cands.push(caps.join(" "));
  caps.slice().sort((a, b) => b.length - a.length).forEach((w) => cands.push(w));
  const stripped = searchTermsFrom(text);
  if (stripped) { if (stripped.indexOf(" ") >= 0) cands.push(stripped); else if (!GENERIC.has(stripped) && stripped.length >= 3) cands.push(stripped); }
  // A bare number is a street number ONLY when the text actually reads like an address — otherwise
  // it's a code/amperage/measurement in an NEC or general question and must NOT drive a project search.
  const looksAddr = /\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|ct|court|way|cir|circle|pl|place|ter|terrace|trl|trail|hwy|loop|apt|unit|suite)\b/i.test(text) || /,\s*[A-Za-z]{2}\b/.test(text) || /\b(who(?:'s| is)?\s+(?:at|lives?|located)|address|reside)\b/i.test(text);
  const num = looksAddr ? (String(text).match(/\b\d{2,6}\b/g) || [])[0] : null; if (num) cands.push(num); // street number
  const seen = new Set(), queries = [];
  for (const q of cands) { const k = q.toLowerCase(); if (q && !seen.has(k)) { seen.add(k); queries.push(q); } if (queries.length >= 4) break; }
  for (const q of queries) {
    try { const res = await toolSearchProjects({ query: q }); if (res && Array.isArray(res.matches) && res.matches.length) return { res, query: q }; } catch (e) {}
  }
  return { res: { count: 0, matches: [] }, query: queries[0] || stripped || String(text) };
}

// ---- READ-ONLY tool implementations ----------------------------------------

// 1) search_projects — word search across Zoho Deals (DL#, customer, or address).
async function toolSearchProjects(input) {
  const query = String((input && input.query) || "").trim();
  if (query.length < 2) return { error: "query too short (need at least 2 characters)" };
  if (!hasZoho()) return { error: "Zoho is not configured on this server" };
  const token = await getAccessToken();
  const fields = "Deal_Name,Stage,Address,City,State,Zip,Installation_Team,Installation_Start_Date";
  const rows = await zohoSearch("Deals",
    `word=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&per_page=25&page=1`, token);
  const matches = rows.slice(0, 8).map((d) => {
    const p = parseDeal(d.Deal_Name);
    const address = [clean(d.Address), clean(d.City), [clean(d.State), clean(d.Zip)].filter(Boolean).join(" ")]
      .filter(Boolean).join(", ") || p.address || "";
    return {
      dl: p.num || "",
      customer: p.customer || d.Deal_Name || "",
      address,
      type: "deal",
      stage: d.Stage || "",
      crew: lookup(d.Installation_Team) || "",
      startDate: d.Installation_Start_Date || "",
      zohoUrl: `https://crm.zoho.com/crm/${ORG}/tab/Potentials/${d.id}`,
    };
  });
  return { count: matches.length, matches };
}

// 2) get_job_details — full picture for one DL (deal -> installation + service tickets + final inspection).
async function toolGetJobDetails(input) {
  const dl = normDL((input && input.dl) || "");
  if (!/^(?:RDL|RL|DL|MSP|S)\d{2,}$/.test(dl)) return { error: `not a valid DL number: ${(input && input.dl) || ""}` };
  if (!hasZoho()) return { error: "Zoho is not configured on this server" };
  const token = await getAccessToken();

  // Find the deal by Deal_Name starts_with the DL.
  const dealFields = "Deal_Name,Stage,Address,City,State,Zip,Authority_Having_Jurisdiction_AHJ,Client_Phone,Client_Mobile,System_Size_kW1";
  const deals = await zohoSearch("Deals",
    `criteria=${encodeURIComponent(`(Deal_Name:starts_with:${dl})`)}&fields=${encodeURIComponent(dealFields)}&per_page=5`, token);
  const deal = deals[0];
  if (!deal) return { found: false, note: `No deal found for ${dl}` };
  const p = parseDeal(deal.Deal_Name);
  const address = [clean(deal.Address), clean(deal.City), [clean(deal.State), clean(deal.Zip)].filter(Boolean).join(" ")]
    .filter(Boolean).join(", ") || p.address || "";

  // Related records — each guarded so one failure doesn't sink the whole lookup.
  const dealId = deal.id;
  const instFields = "Name,Stage,Installation_Start_Date,Installation_Complete_Date,Installation_Proposed_Date,Installation_Confirmed_Date,Installation_Team,Installation_Notes,Roof_Notes,AHJ_Specific_Install_Notes,Number_of_Days_Needed,MSP_Upgrade_Required,VIP_Installation";
  const svcFields = "Name,Ticket_Status,Scheduled_Visit_1,Type_of_Service,Service_Description,Assigned_Technician,Technicians,Ticket_Completion_Date,Date_Complete,Priority";
  const [installs, services, inspections, dealNotes] = await Promise.all([
    zohoSearch("Installation", `criteria=${encodeURIComponent(`(Deal:equals:${dealId})`)}&fields=${encodeURIComponent(instFields)}&per_page=10`, token).catch(() => []),
    zohoSearch("Service_Ticket", `criteria=${encodeURIComponent(`(Associated_Deal:equals:${dealId})`)}&fields=${encodeURIComponent(svcFields)}&per_page=25`, token).catch(() => []),
    zohoSearch("Final_Inspectin", `criteria=${encodeURIComponent(`(Deal:equals:${dealId})`)}&fields=${encodeURIComponent("Name,Inspection_Stage,Final_Inspection_Notes")}&per_page=10`, token).catch(() => []),
    fetchNotes("Deals", dealId, token),
  ]);

  const instArr = Array.isArray(installs) ? installs : [];
  const install = instArr.map((it) => ({
    record: it.Name || "",
    stage: it.Stage || "",
    startDate: it.Installation_Start_Date || "",
    completeDate: it.Installation_Complete_Date || "",
    proposedDate: it.Installation_Proposed_Date || "",
    confirmedDate: it.Installation_Confirmed_Date || "",
    crew: lookup(it.Installation_Team) || "",
    daysNeeded: it.Number_of_Days_Needed || "",
    mspUpgrade: it.MSP_Upgrade_Required || "",
    vip: it.VIP_Installation || "",
    installNotes: (it.Installation_Notes || "").trim().replace(/\s+/g, " ").slice(0, 300),
    roofNotes: (it.Roof_Notes || "").trim().replace(/\s+/g, " ").slice(0, 200),
    ahjNotes: (it.AHJ_Specific_Install_Notes || "").trim().replace(/\s+/g, " ").slice(0, 150), // usually permit boilerplate — keep short
  }));

  // Also pull CRM Notes attached to the Installation record(s) and merge with the Deal's notes.
  let notes = Array.isArray(dealNotes) ? dealNotes.slice() : [];
  const instIds = instArr.map((it) => it.id).filter(Boolean).slice(0, 2);
  const instNoteSets = await Promise.all(instIds.map((iid) => fetchNotes("Installation", iid, token)));
  instNoteSets.forEach((set) => { notes = notes.concat(set); });
  const seen = new Set();
  notes = notes.filter((n) => { const k = (n.time || "") + "|" + (n.content || "").slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(b.time || "").localeCompare(String(a.time || ""))).slice(0, 8)
    .map((n) => ({ title: n.title, author: n.author, time: n.time, content: (n.content || "").replace(/\s+/g, " ").slice(0, 240) }));

  const tickets = (Array.isArray(services) ? services : []).map((s) => ({
    ticket: s.Name || "",
    status: (s.Ticket_Status || "").trim(),
    scheduledVisit: s.Scheduled_Visit_1 || "",
    completedDate: s.Ticket_Completion_Date || s.Date_Complete || "",
    type: Array.isArray(s.Type_of_Service) ? s.Type_of_Service.join(", ") : (s.Type_of_Service || ""),
    description: (s.Service_Description || "").trim().replace(/\s+/g, " ").slice(0, 320),
    // The ticket's OWN assigned tech (may be blank). NOT the install crew — never assume.
    tech: lookup(s.Assigned_Technician) || (Array.isArray(s.Technicians) ? s.Technicians.map((x) => x && x.name).filter(Boolean).join(", ") : lookup(s.Technicians)) || "",
    priority: s.Priority || "",
  }));

  // Deal-level inspection status is what coordinators see — fetch it, guarded so a bad field
  // name only loses this detail rather than breaking the whole lookup.
  let dealInsp = {};
  try {
    const ir = await fetchT(`${API_DOMAIN}/crm/${API_VERSION}/Deals/${encodeURIComponent(dealId)}?fields=${encodeURIComponent("Inspection_Stage,Final_Inspection_Approved")}`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }, 10000);
    if (ir && ir.ok) { const dj = await ir.json().catch(() => ({})); const row = (dj.data && dj.data[0]) || {}; dealInsp = { dealInspectionStage: row.Inspection_Stage || "", finalInspectionApproved: row.Final_Inspection_Approved || "" }; }
  } catch (e) {}
  const insArr = Array.isArray(inspections) ? inspections : [];
  const inspection = Object.assign({
    found: !!insArr[0],
    record: insArr[0] ? (insArr[0].Name || "") : "",
    subRecordStage: insArr[0] ? (insArr[0].Inspection_Stage || "") : "",
    notes: insArr[0] ? (insArr[0].Final_Inspection_Notes || "").trim() : "",
  }, dealInsp);

  return {
    found: true,
    dl: p.num || dl,
    customer: p.customer || deal.Deal_Name || "",
    address,
    phone: clean(deal.Client_Phone) || clean(deal.Client_Mobile) || "",
    ahj: lookup(deal.Authority_Having_Jurisdiction_AHJ) || "",
    dealStage: deal.Stage || "",
    systemKw: (deal.System_Size_kW1 != null && deal.System_Size_kW1 !== 0) ? deal.System_Size_kW1 : null,
    installations: install,
    serviceTickets: tickets,
    inspection,
    notes,                       // real CRM Notes (coordinator/crew) attached to the Deal + Installation
    noteCount: notes.length,
    zohoUrl: `https://crm.zoho.com/crm/${ORG}/tab/Potentials/${deal.id}`,
  };
}

// 3) search_sitecapture — search SiteCapture projects (direct creds + service-app proxy in parallel).
const _isDate = (s) => /^\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/.test(String(s || ""));
const _isAddr = (s) => { s = String(s || ""); return /\d/.test(s) && (/,/.test(s) || /\b[A-Z]{2}\b/.test(s) || /\b(st|ave|rd|dr|ln|blvd|ct|way|cir|pl|ter|trl|hwy)\b/i.test(s)); };
function scBasic() {
  if (process.env.SITECAPTURE_USER && process.env.SITECAPTURE_PASS)
    return "Basic " + Buffer.from(process.env.SITECAPTURE_USER + ":" + process.env.SITECAPTURE_PASS).toString("base64");
  if (process.env.Site_Capture_Key) {
    const k = process.env.Site_Capture_Key.trim();
    return k.toLowerCase().startsWith("basic ") ? k : (k.indexOf(":") >= 0 ? "Basic " + Buffer.from(k).toString("base64") : "Basic " + k);
  }
  return null;
}
function scMap(arr) {
  return (arr || []).slice(0, 8).map((pr) => {
    const lines = [pr.display_line2, pr.display_line3, pr.display_line4, pr.display_line5]
      .map((x) => (x == null ? "" : String(x).trim())).filter(Boolean);
    const nonDate = lines.filter((x) => !_isDate(x));
    const address = pr.address || pr.site_address || nonDate.find(_isAddr) || "";
    const media = pr.media_count != null ? pr.media_count : (pr.photo_count != null ? pr.photo_count : (Array.isArray(pr.media) ? pr.media.length : null));
    return {
      name: pr.display_line1 || pr.name || pr.project_name || pr.title || ("Project " + (pr.id || "")),
      address,
      status: (pr.status || pr.project_status || "").toString(),
      media: media != null ? media : undefined,
    };
  });
}
async function toolSearchSitecapture(input) {
  const q = String((input && input.query) || "").trim().slice(0, 80);
  if (q.length < 2) return { error: "query too short (need at least 2 characters)" };
  const basic = scBasic();
  const readArr = async (r) => { if (!r || !r.ok) return null; try { const b = await r.json(); return Array.isArray(b) ? b : (b.data || b.projects || b.results || []); } catch (e) { return null; } };
  const directU = basic ? ("https://api.sitecapture.com/customer_api/2_0/projects?max=100&offset=0&search=" + encodeURIComponent(q) + "&exact_text=false") : null;
  const proxyU = SC_PROXY + "?path=projects&offset=0&q=" + encodeURIComponent(q);
  const [dArr, pArr] = await Promise.all([
    directU ? fetchT(directU, { headers: { Authorization: basic, "API_KEY": SC_FIXED, Accept: "application/json" } }, 10000).then(readArr) : Promise.resolve(null),
    fetchT(proxyU, { headers: { Accept: "application/json" } }, 10000).then(readArr),
  ]);
  const arr = dArr || pArr;
  if (!arr) return { error: "SiteCapture search unavailable" };
  const projects = scMap(arr);
  return { count: projects.length, projects };
}

// 4) count_jobs — aggregate installs/services over a DATE RANGE, broken down by crew + MSP.
// Answers "how many … did Crew #X do in July", totals, per-crew tallies. Pulls the records whose
// date falls in [from,to], canonicalizes each crew, and tallies — so counts always match the board.
async function toolCountJobs(input) {
  if (!hasZoho()) return { error: "Zoho is not configured on this server" };
  const module = (input && /serv/i.test(String(input.module || ""))) ? "service" : "install";
  const from = String((input && input.from) || "").slice(0, 10);
  const to = String((input && input.to) || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return { error: "need from and to dates as YYYY-MM-DD" };
  const token = await getAccessToken();

  const isSvc = module === "service";
  const dateField = (input && input.dateField) ||
    (isSvc ? "Ticket_Completion_Date" : "Installation_Start_Date");
  const mod = isSvc ? "Service_Ticket" : "Installation";
  const fields = isSvc
    ? "Name,Associated_Deal,Assigned_Technician,Scheduled_Visit_1,Ticket_Completion_Date,Type_of_Service,Ticket_Status"
    : "Name,Deal,Installation_Team,Installation_Start_Date,Installation_Complete_Date,MSP_Upgrade_Required,Stage";

  // Page through (a month is ~120; cap at 2000 to respect Zoho's single-search limit).
  const rows = [];
  for (let page = 1; page <= 10; page++) {
    let batch;
    try {
      batch = await zohoSearch(mod, `criteria=${encodeURIComponent(`(${dateField}:between:${from},${to})`)}&fields=${encodeURIComponent(fields)}&per_page=200&page=${page}`, token);
    } catch (e) { return { error: String((e && e.message) || e) }; }
    if (!batch || !batch.length) break;
    rows.push(...batch);
    if (batch.length < 200) break;
  }

  const items = rows.map((r) => {
    const deal = parseDeal(lookup(isSvc ? r.Associated_Deal : r.Deal));
    const crew = canonTeam(lookup(isSvc ? r.Assigned_Technician : r.Installation_Team));
    const mspFlag = String(r.MSP_Upgrade_Required || "");
    const msp = mspFlag === "MSP" || r.MSP_Upgrade_Required === true || /^MSP/i.test(deal.num || "");
    const roofing = crew === "Windmar Roofing" || /^RL/i.test(deal.num || "");
    return {
      dl: deal.num || r.Name, customer: deal.customer || "", crew, msp, roofing,
      stage: isSvc ? (r.Ticket_Status || "") : (r.Stage || ""),
      date: isSvc ? (r.Ticket_Completion_Date || r.Scheduled_Visit_1 || "") : (r.Installation_Start_Date || ""),
    };
  });

  // Optional filters the caller asked for.
  const crewFilter = input && input.crew ? canonTeam(input.crew) : "";
  const typeFilter = input && input.type ? String(input.type).toLowerCase() : "";
  let matched = items;
  if (crewFilter) matched = matched.filter((x) => x.crew === crewFilter);
  if (/msp/.test(typeFilter)) matched = matched.filter((x) => x.msp);
  else if (/roof/.test(typeFilter)) matched = matched.filter((x) => x.roofing);
  else if (/solar|install/.test(typeFilter)) matched = matched.filter((x) => !x.roofing);

  // Per-crew breakdown over the WHOLE window (so the model can answer follow-ups too).
  const byCrew = {};
  for (const x of items) {
    const b = byCrew[x.crew] || (byCrew[x.crew] = { total: 0, msp: 0, roofing: 0 });
    b.total++; if (x.msp) b.msp++; if (x.roofing) b.roofing++;
  }
  const totalMsp = items.filter((x) => x.msp).length;
  return {
    module, dateField, from, to,
    total: items.length, totalMsp,
    matchedCount: matched.length,
    filters: { crew: crewFilter || null, type: typeFilter || null },
    byCrew,
    note: "msp = install flagged MSP_Upgrade_Required='MSP' OR an MSP-coded deal. roofing = Windmar Roofing / RL-coded. 'matchedCount' already applies the crew/type filters you passed.",
    sample: matched.slice(0, 40).map((x) => ({ dl: x.dl, customer: x.customer, crew: x.crew, msp: x.msp, date: x.date, stage: x.stage })),
  };
}

const TOOLS = [
  {
    name: "search_projects",
    description: "Search WindMar's Zoho CRM for projects by DL number, customer name, or street address. Returns up to 8 concise matches with DL#, customer, address, stage, crew, and start date. Use this to find a project when you don't already have the exact DL number.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "A DL number (e.g. DL8765), a customer name, or a street/city." } }, required: ["query"] },
  },
  {
    name: "get_job_details",
    description: "Get the full picture for one project by its DL number: installation (stage, start/complete dates, crew, notes), any service tickets (status, scheduled visit, description), final inspection / post-installation status, AHJ, and address. Use after you know the DL number.",
    input_schema: { type: "object", properties: { dl: { type: "string", description: "The DL number, e.g. \"DL8765\"." } }, required: ["dl"] },
  },
  {
    name: "search_sitecapture",
    description: "Search SiteCapture field-project records by name or address. Returns project name, address, status, and photo/media count when available.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "Customer name or address to search SiteCapture for." } }, required: ["query"] },
  },
  {
    name: "count_jobs",
    description: "Count / aggregate WindMar jobs over a DATE RANGE. Use for ANY 'how many', 'how much', total, tally, or per-crew breakdown question — e.g. 'how many MSPs did Crew #1S do in July', 'how many installs last month', 'which crew did the most jobs this week'. Queries Zoho Installations (module 'install', default) or Service tickets (module 'service') whose date is within [from,to], then returns the total, the total MSP count, a per-crew breakdown {total, msp, roofing}, and a sample list. You MUST compute the from/to dates yourself from TODAY'S DATE (given in your instructions); for a bare month name with no year, use the most recent PAST occurrence. Pass crew and/or type to pre-filter (the result's matchedCount reflects those filters).",
    input_schema: { type: "object", properties: {
      module: { type: "string", enum: ["install", "service"], description: "'install' (default) or 'service'." },
      from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)." },
      to: { type: "string", description: "End date YYYY-MM-DD (inclusive)." },
      crew: { type: "string", description: "Optional crew filter, e.g. 'Crew #1S', 'Elite Crew #2', 'Crew H'." },
      type: { type: "string", description: "Optional job-type filter: 'msp', 'roofing', or 'solar'/'install'." },
      dateField: { type: "string", description: "Optional Zoho date field to range on (default Installation_Start_Date for installs, Ticket_Completion_Date for service)." },
    }, required: ["from", "to"] },
  },
];

async function runTool(name, input) {
  try {
    if (name === "search_projects") return await toolSearchProjects(input);
    if (name === "get_job_details") return await toolGetJobDetails(input);
    if (name === "search_sitecapture") return await toolSearchSitecapture(input);
    if (name === "count_jobs") return await toolCountJobs(input);
    return { error: `unknown tool: ${name}` };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

// ---- system persona ---------------------------------------------------------

// NEC / equipment expertise — ported from the Field HUB "NEC Assistant" so Sunny can answer
// electrical-code + install questions directly (no tool needed for these).
const NEC_SKILL = [
  "You are ALSO WindMar's expert NEC code + equipment assistant — an experienced licensed electrician and solar installer in Central Florida. Answer electrical, code, and equipment questions directly from your own knowledge (no tool needed for those).",
  "Code answers: give the DIRECT answer FIRST (exact wire size / breaker / torque / measurement / clearance), then a short WHY with the NEC 2020/2023 article and real numbers — Table 310.16 ampacity, 250.122 EGC, 314.16 box fill, 690.12 rapid shutdown/roof setbacks, 110.26 working clearances, 240.24 panel height, 705.13 PCS. Note Florida Building Code / high-wind specifics when relevant. Keep it tight (<~180 words), field-ready.",
  "For math (voltage drop, conductor/OCPD sizing, conduit fill, string sizing): give the quick rule-of-thumb, then tell them to verify exact numbers with a calculator — don't grind long arithmetic.",
  "Tesla Powerwall 3: 13.5 kWh, 11.5 kW AC continuous (48A default), up to 20 kW DC in, 6 MPPTs, P/N 1707000, default 60A breaker, 120/240V split-phase, up to 4 PW3 + 3 Expansion (7 total); PCS per NEC 705.13 avoids the 120% rule. Gateway 3 P/N 1841000 (200A). Expansion 1807000 adds capacity, not kW. MCI rapid-shutdown required per PV string. LOTOV = 14-step lock-out/tag-out/verify. UL 9540A; battery fire = water for cooling only + SCBA (hydrofluoric acid).",
  "Identify major brands with model + key specs + relevant NEC article: Tesla, SolarEdge (SE3300-SE6000, Synergy 3-phase, SafeDC, optimizers), Qcells/Hanwha (Q.PEAK DUO, Q.HOME COMBINER 80 G1 = 125A Eaton BR bus), Generac PWRcell + ATS (100A torque 50 in-lbs / 200A 275 in-lbs, Cat5 per 725.136), Enphase IQ7/IQ8, Eaton BR/CH, Square D QO/Homeline, GE, Siemens.",
  "WindMar standard racking = SnapNrack (Ultra Rail 6000-series, UL 2703 integrated bonding per NEC 690.43; mid/end clamps 8-10 ft-lbs; 5/16\"x4\" SS lag, min 1.5\" rafter penetration; seal under flashing). WindMar standard roofing = Owens Corning (Duration / Duration STORM; SureNail — nail IN the strip; FBC R905.2.6 requires 6-nail in FL high-wind; Ice & Water first 3 ft + valleys; flash under upper course / over lower; 3\" roof-edge fire setback per 690.12(B)(2)).",
  "If a code/equipment question is vague, ask ONE short clarifying question with 2-3 likely options instead of guessing.",
].join(" ");

// Full WindMar solar/roofing/service knowledge base — WinMI's built-in expertise (given to Claude).
const WINDMAR_KB = `WINDMAR FIELD KNOWLEDGE (Solar / Roofing / Service, Florida). Codes: NEC 2020 (FL statewide), NEC 2023 phasing in; Florida Building Code 8th ed. Jobs DL-XXXX; types SOL/BAT/ROO; inspections RI, SE, UG, FI, PV, LV, RF, ES.

ELECTRICAL (NEC)
- Ampacity Table 310.16, 75°C column for terminations (110.14(C)): #14=15A, #12=20A, #10=30/35A, #8=50A, #6=65A, #4=85A, 1/0=150A, 4/0=230A. Rooftop sun-exposed conduit adds ambient; apply temp correction (310.15) + fill adjustment (>3 current-carrying conductors).
- OCPD sizes 240.6 (15,20,25,30,40,50,60,70,90,100,110,125,150,175,200…). 240.4(B) next-size-up ≤800A; 240.4(D) small-conductor limits (#14=15A,#12=20A,#10=30A). Continuous loads ×125% (210.19/215.2). Breaker max height 6'7" (240.24).
- PV: 690.8(A) max current, 690.8(B) conductors/OCPD at 125% of Isc (stacks to 156% of Isc). Rapid shutdown 690.12: ≤80V within 30s inside array boundary, ≤30V outside.
- EGC Table 250.122 by OCPD: 15A=#14, 20A=#12, 60A=#10, 100A=#8, 200A=#6Cu/#4Al. GEC Table 250.66. PV bonding 690.43 (listed integrated bonding OK), EGC 690.45.
- Box fill 314.16: #14=2.0, #12=2.25, #10=2.5 in³ (conductors + clamps 1 + device 2 + grounds 1).
- Working space 110.26: 3ft deep, 30in wide, 6.5ft high. Roof fire setbacks 690.12(B)(2)/FBC: 3ft ridge pathway, 18in from ridge, 3ft access paths.
- Interconnection 705.12(B)(3) 120% rule: busbar×1.2 ≥ main breaker + PV backfeed; backfeed at opposite end. PCS per 705.13 (Powerwall 3 / Gateway limit current → 120% rule may not apply). Line-side tap 705.11.
- Voltage drop target ≤2% feeder, ≤3% branch, ≤5% total. Conduit fill 40% for >2 conductors.
- FL high-wind: attachment to ASCE 7 (140–180 mph, HVHZ Miami-Dade/Broward); FL Product Approval / Miami-Dade NOA required on racking, modules, roofing.

EQUIPMENT
- Tesla Powerwall 3: 13.5 kWh, 11.5 kW AC cont, 120/240V split-phase; 48A default → 60A backfeed; integrated inverter, 6 MPPTs, up to 20 kW PV DC; Backup Gateway 3; up to 4 units + DC Expansion (13.5 kWh, no inverter). MCI = rapid shutdown; PCS per 705.13; lug torque per label (~40–80 in-lb); NEMA 3R. PW2/+ = 5–7.6 kW AC-coupled, needs Gateway 2.
- SolarEdge: 1φ SE3300–SE6000 (240V, 500Vdc, SafeDC→1V/optimizer when OFF), HD-Wave; optimizers = module MPPT + rapid shutdown; 3φ Synergy SE50K–120K (1000Vdc, SetApp). String check ~1V×#optimizers with inverter OFF.
- Qcells Q.HOME COMBINER 80 (G1): 125A Eaton BR bus, 64A cont; Solar-Only/Backup/Grid modes; Q.PEAK DUO modules.
- Generac PWRcell ATS: 100A torque 50 in-lb; 200A torque 275 in-lb (calibrated wrench, not impact); Cat5 control in separate raceway per 725.136; 8 load-priority levels.
- Enphase IQ7/IQ8 microinverters, AC-coupled, rapid-shutdown compliant, IQ Gateway comms.
- Breakers (never mix brands): Eaton BR(1")/CH(¾"), Square D QO(¾")/Homeline(1"), Siemens, GE/ABB — match per UL listing.

ROOFING
- Owens Corning Duration / Duration STORM: SureNail — nail IN the fabric strip; FL high-wind 6-nail per FBC R905.2.6; Ice & Water first 3ft + valleys; matching starter + hip/ridge for warranty.
- SnapNrack Ultra Rail (6000): UL 2703 integrated bonding (690.43(C)); mid/end clamp torque 8–10 ft-lb; 5/16"×4" SS lag, min 1.5" rafter penetration, pilot-drilled; flash under upper course/over lower + sealant on shank. Unirac/IronRidge acceptable alternates.

SAFETY
- LOTOV (14-step): alert → open AC → open DC/string → wait 5 min → verify 0V AC → verify 0V DC → test emergency disconnect → lock OFF → tag OUT OF SERVICE → log → re-verify 0V → announce clear → multi-day log → restore only when supervisor-verified. PPE: CAT2 arc-rated, Class 0 gloves (1000V), insulated tools, CAT III/IV meter.
- Energize PV/DC first, then battery, then commission via app; de-energize reverse. Battery fire: UL 9540A, water for cooling only (never expect to extinguish Li), HF/hydrofluoric-acid vapor → SCBA, evacuate, call FD. Fall protection >6ft; heat: 1 gal water/person/hr; 30-30 lightning; stop work in rain; no panel setting >20 mph.

SERVICE / MONITORING
- Common: battery not backing up (Gateway CTs reversed / grid-code mismatch), phase/rotation errors (SolarEdge #29/#30), comm loss (Ethernet>Wi-Fi>cellular; check Gateway LED), isolation/ground fault #25 (megohmmeter each string, healthy >2MΩ), AC voltage high #14/#31 (upsize conductor), country-not-set #44.
- Commissioning: verify Vac/Vdc/Pac, optimizer/micro count = module count, production matches kW, app "Connected", backup reserve %. Portals: SolarEdge monitoring, Enphase Enlighten, Qcells Q.OMMAND, Tesla app.
- Installing contractor owns code compliance; always confirm AHJ/utility requirements.`;

function systemPrompt(lang) {
  const es = lang === "es";
  return [
    "You are WinMI, WindMar Home's friendly, upbeat futuristic assistant droid. ☀️🤖",
    "You help WindMar coordinators and crews with solar & roofing PROJECTS in Florida, AND you are an expert on the NEC electrical code and installation equipment.",
    "You can look up LIVE data in Zoho CRM and SiteCapture using your tools.",
    "You are STRICTLY READ-ONLY: you can never change, edit, schedule, or delete anything.",
    "If a user asks you to edit, schedule, reassign, or change data, warmly explain that you can't make changes, and tell them to use the Coordinator tab or the Calendar tab's edit button to do that.",
    "NEVER invent DL numbers, statuses, dates, crews, addresses, or names. Only state what your tools return. If a tool finds nothing, say so plainly — do not guess. (This applies to project DATA; your NEC/equipment knowledge below is yours to answer from directly.)",
    "Be concise and warm. Keep answers short and mobile-friendly (a few lines, simple formatting).",
    (es
      ? "VISUALIZACIÓN NEC: Cuando una pregunta de NEC/eléctrica/equipos/techos se entienda mejor con un dibujo (diagrama unifilar, calibre de conductor y breaker, llenado de caja, límite de rapid shutdown, interconexión/regla del 120%, detalle de conexión/torque, o distribución/setbacks en techo), INCLUYE SIEMPRE UN diagrama SVG claro y autónomo dentro de un bloque ```svg — con viewBox, etiquetas legibles y valores reales — seguido de una descripción escrita detallada. El SVG debe ser autónomo: solo atributos en línea, SIN <script>, SIN URLs/imágenes/fuentes externas, ancho ~360."
      : "NEC VISUALS: When a NEC/electrical/equipment/roofing question is clearer with a picture (a one-line wiring diagram, conductor & breaker sizing, box fill, rapid-shutdown boundary, interconnection/120% busbar, a connection/torque detail, or roof layout/setbacks), ALWAYS include ONE clear, self-contained SVG diagram inside a ```svg fenced block — with a viewBox, readable labels, and real values — followed by a thorough written description. The SVG MUST be self-contained: inline attributes only, NO <script>, NO external URLs/images/fonts, ~360px wide."),
    NEC_SKILL,
    es
      ? "Responde SIEMPRE en español (el usuario prefiere español)."
      : "Respond in the user's language — if they write in Spanish, answer in Spanish; otherwise English.",
  ].join(" ");
}

// Coerce incoming messages into the Anthropic shape (string content, valid roles only).
function normalizeMessages(raw) {
  const out = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    let content = m.content;
    if (typeof content !== "string") { try { content = JSON.stringify(content); } catch (e) { content = String(content == null ? "" : content); } }
    content = content.trim();
    if (!content) continue;
    out.push({ role: m.role, content });
  }
  // Anthropic requires the first message to be from the user.
  while (out.length && out[0].role !== "user") out.shift();
  return out.slice(-20);
}

// ---- AI brain: the Field HUB's NEC Assistant (Gemini) --------------------------------------
// The itinerary has NO AI key (org policy), so Sunny borrows the already-working NEC Assistant
// on the Field HUB, which accepts { question, history, lang, knowledgeContext }. We feed it live
// Zoho/SiteCapture data as knowledgeContext so it can also answer project questions.
const NEC_AI_URL = process.env.NEC_AI_URL || "https://project-g7v0r.vercel.app/api/nec-ai";

async function callNecBrain(question, history, lang, knowledgeContext) {
  const r = await fetchT(NEC_AI_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, history, lang, knowledgeContext }),
  }, 42000);
  if (!r) throw new Error("assistant brain timed out");
  const data = await r.json().catch(() => ({}));
  if (!r.ok || (!data.answer && data.error)) throw new Error((data && data.error) || `brain ${r.status}`);
  // source "knowledge-fallback" means Gemini failed/timed out and it echoed our context back —
  // that's NOT a real answer; signal it so the caller can retry leaner instead of dumping raw text.
  return { answer: String(data.answer || ""), source: data.source || "" };
}

// Direct Claude (Anthropic) call — WinMI's PRIMARY freeform/NEC brain when a valid ANTHROPIC_API_KEY
// is set, so it doesn't depend on the Field HUB's rate-limited Gemini. systemPrompt() carries the
// WinMI persona + NEC expertise; we add the app + Zoho guides so it can field those too.
async function callClaude(apiKey, question, history, lang) {
  const sys = systemPrompt(lang) + "\n\n" + WINDMAR_KB + "\n\n" + APP_GUIDE + "\n\n" + ZOHO_GUIDE;
  const msgs = (history || []).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: String((m && (m.text || m.content)) || "") })).filter((m) => m.content);
  msgs.push({ role: "user", content: String(question) });
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  const r = await fetchT(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1800, system: sys, messages: msgs.slice(-16) }),
  }, 30000);
  if (!r) throw new Error("Claude timed out");
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude " + r.status + ": " + String((d && d.error && d.error.message) || "").slice(0, 140));
  return (Array.isArray(d.content) ? d.content : []).filter((b) => b && b.type === "text").map((b) => b.text).join("").trim();
}

// AGENTIC Claude — the smart brain. Claude gets the full tool set (search_projects, get_job_details,
// search_sitecapture, count_jobs) and decides what to call, looping tool_use → tool_result until it
// has an answer. This is what lets WinMI handle ANY work question — lookups, searches, and
// aggregate "how many …" analytics — instead of brittle keyword routing. Returns {answer, used}.
async function callClaudeAgentic(apiKey, question, history, lang) {
  const today = todayISO();
  const guide =
    "\n\nTODAY'S DATE: " + today + ". Use it to resolve 'this month', 'July', 'last week', 'this year' into concrete from/to dates. For a bare month name with NO year, assume the most recent PAST occurrence.\n" +
    "TOOLS: You have LIVE read-only tools. ALWAYS use a tool for anything about a specific customer/project (search_projects → get_job_details), a name/address lookup, SiteCapture, or a COUNT/total/tally over a period (count_jobs). NEVER guess project data or make up numbers — if a tool returns nothing, say so. Answer NEC/electrical/equipment/how-to-use-the-app questions directly from your knowledge (no tool needed). Crew names are canonical: Elite Crew #2/#3, Crew #1S/#2S/#3S, Crew H, Windmar Roofing.";
  const sys = systemPrompt(lang) + guide + "\n\n" + WINDMAR_KB + "\n\n" + APP_GUIDE + "\n\n" + ZOHO_GUIDE;
  const msgs = (history || []).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: String((m && (m.text || m.content)) || "") })).filter((m) => m.content);
  msgs.push({ role: "user", content: String(question) });
  while (msgs.length && msgs[0].role !== "user") msgs.shift();

  const used = [];
  for (let step = 0; step < 4; step++) {
    const r = await fetchT(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1800, system: sys, tools: TOOLS, messages: msgs.slice(-16) }),
    }, 40000);
    if (!r) throw new Error("Claude timed out");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("Claude " + r.status + ": " + String((d && d.error && d.error.message) || "").slice(0, 140));
    const blocks = Array.isArray(d.content) ? d.content : [];
    const toolUses = blocks.filter((b) => b && b.type === "tool_use");
    if (d.stop_reason === "tool_use" && toolUses.length) {
      msgs.push({ role: "assistant", content: blocks });
      const results = [];
      for (const tu of toolUses) {
        used.push(tu.name);
        const out = await runTool(tu.name, tu.input || {});
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 7000) });
      }
      msgs.push({ role: "user", content: results });
      continue; // let Claude read the tool output and answer (or call another tool)
    }
    const text = blocks.filter((b) => b && b.type === "text").map((b) => b.text).join("").trim();
    return { answer: text, used };
  }
  // Hit the step cap — ask once more for a final text answer with no further tools.
  try {
    const r = await fetchT(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: sys, messages: msgs.slice(-16) }),
    }, 30000);
    const d = r ? await r.json().catch(() => ({})) : {};
    const text = (Array.isArray(d.content) ? d.content : []).filter((b) => b && b.type === "text").map((b) => b.text).join("").trim();
    return { answer: text, used };
  } catch (e) { return { answer: "", used }; }
}

// Claude VISION — analyze a field photo (equipment, panel, breaker box, roof, plan) with WindMar
// expertise. Returns identification + specs + NEC/code notes + install guidance.
async function callClaudeVision(apiKey, question, att, history, lang) {
  const es = lang === "es";
  const isDoc = /pdf/i.test(att.mediaType || "");
  const mode = isDoc
    ? (es ? "MODO DOCUMENTO: Lee el documento con cuidado y da una descripción/resumen DETALLADO y preciso. Si es un plano, BOM, hoja de especificaciones, permiso o reporte, extrae los datos clave (equipo, cantidades, valores, direcciones, fechas) y señala lo relevante al NEC 2020/2023 + código de Florida o estándares WindMar. Cita los detalles; no inventes."
             : "DOCUMENT MODE: Read the attached document carefully and give a DETAILED, accurate description/summary. If it's a plan set, BOM, spec sheet, permit, or report, extract the key details (equipment, quantities, ratings, addresses, dates) and flag anything relevant to NEC 2020/2023 + Florida code or WindMar standards. Quote specifics; don't invent.")
    : (es ? "MODO FOTO: Analiza la imagen con máxima precisión: identifica CADA equipo (marca + modelo + specs), señala problemas/violaciones de código con el artículo exacto, y da recomendaciones. Si algo no se ve, dilo."
             : "PHOTO MODE: Analyze the field image with maximum precision. Identify EVERY piece of equipment (brand + model/part # + key specs), flag any code violations (NEC 2020/2023 + Florida code) with the exact article, and give actionable install guidance. If something can't be seen clearly, say so.");
  const sys = systemPrompt(lang) + "\n\n" + mode + "\n\n" + WINDMAR_KB;
  const block = isDoc
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: att.data } }
    : { type: "image", source: { type: "base64", media_type: att.mediaType || "image/jpeg", data: att.data } };
  const content = [
    block,
    { type: "text", text: question || (es ? (isDoc ? "Describe y analiza este documento en detalle." : "Analiza esta foto — identifica el equipo y problemas de código.") : (isDoc ? "Describe and analyze this document in detail." : "Analyze this photo — identify the equipment and any code issues.")) },
  ];
  const msgs = (history || []).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: String((m && (m.text || m.content)) || "") })).filter((m) => m.content);
  msgs.push({ role: "user", content });
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  const r = await fetchT(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1100, system: sys, messages: msgs.slice(-8) }),
  }, 40000);
  if (!r) throw new Error("Claude vision timed out");
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Claude vision " + r.status + ": " + String((d && d.error && d.error.message) || "").slice(0, 140));
  return (Array.isArray(d.content) ? d.content : []).filter((b) => b && b.type === "text").map((b) => b.text).join("").trim();
}

// The NEC Assistant appends a "FOLLOWUPS: ..." line for the Field HUB's chip UI — strip it here.
function stripFollowups(s) { return String(s || "").replace(/\n*FOLLOWUPS:.*$/is, "").trim(); }

// Best-effort: pull live project data relevant to the question, formatted as knowledge context.
async function gatherContext(text) {
  const used = [], parts = [], records = [];
  let search = null, sitecapture = null;
  if (!hasZoho()) return { context: "", used, records, search, sitecapture };
  const low = String(text || "").toLowerCase();

  // (a) Explicit DL/RDL/RL/MSP numbers → deep lookup each (full record incl. notes).
  const uniqDls = [...new Set((String(text).match(/\b(?:RDL|RL|DL|MSP)\s?\d{3,}\b/ig) || []).map(normDL))].slice(0, 3);
  if (uniqDls.length) {
    const jobs = await Promise.all(uniqDls.map((dl) => toolGetJobDetails({ dl }).catch((e) => ({ error: String((e && e.message) || e) }))));
    jobs.forEach((r, i) => { records.push(r); parts.push("PROJECT " + uniqDls[i] + " (full Zoho record):\n" + JSON.stringify(r)); });
    used.push("get_job_details");
  }

  // (b) SiteCapture, when asked.
  if (/site\s?capture/.test(low)) {
    try { sitecapture = await toolSearchSitecapture({ query: searchTermsFrom(text) || text }); parts.push("SITECAPTURE RESULTS:\n" + JSON.stringify(sitecapture)); used.push("search_sitecapture"); } catch (e) {}
  }

  // (c) No DL → search Zoho by NAME / ADDRESS / PHONE (no keyword required). smartProjectSearch
  // self-gates on real entities (names, addresses, numbers), so pure NEC/app/schema questions
  // (no proper noun) won't trigger a search. Then DEEP-fetch the top match(es).
  if (!uniqDls.length) {
    const digits = String(text).replace(/\D/g, "");
    // Phone lookup (7–15 digits, e.g. "find 813-900-8710").
    if (digits.length >= 7 && digits.length <= 15) {
      try {
        const token = await getAccessToken();
        const rows = await zohoSearch("Deals", "phone=" + encodeURIComponent(digits.slice(-10)) + "&fields=" + encodeURIComponent("Deal_Name,Stage,Address,City,State,Zip") + "&per_page=10", token);
        const matches = rows.map((d) => { const p = parseDeal(d.Deal_Name); return { dl: p.num || "", customer: p.customer || d.Deal_Name || "", address: p.address || [clean(d.Address), clean(d.City)].filter(Boolean).join(", "), stage: d.Stage || "" }; });
        if (matches.length) { search = { count: matches.length, matches }; parts.push("PHONE SEARCH:\n" + JSON.stringify(search)); used.push("search_projects"); }
      } catch (e) {}
    }
    // Name / address search.
    if (!search || !search.matches || !search.matches.length) {
      try { const r = await smartProjectSearch(text); if (r.res && Array.isArray(r.res.matches) && r.res.matches.length) { search = r.res; parts.push('PROJECT SEARCH for "' + r.query + '":\n' + JSON.stringify(r.res)); used.push("search_projects"); } } catch (e) {}
    }
    // Deep-fetch top matches (full status + notes).
    if (search && Array.isArray(search.matches) && search.matches.length) {
      const dls = search.matches.map((m) => normDL(m.dl)).filter((d) => /^(?:RDL|RL|DL|MSP|S)\d{2,}$/.test(d));
      const top = [...new Set(dls)].slice(0, 2);
      if (top.length) {
        const deep = await Promise.all(top.map((dl) => toolGetJobDetails({ dl }).catch((e) => ({ error: String((e && e.message) || e) }))));
        deep.forEach((r2, i) => { records.push(r2); parts.push("PROJECT " + top[i] + " (full Zoho record):\n" + JSON.stringify(r2)); });
        if (used.indexOf("get_job_details") < 0) used.push("get_job_details");
      }
    }
    // SiteCapture fallback — Zoho found nothing but the user named an entity → search SiteCapture too.
    if ((!search || !search.matches || !search.matches.length) && !sitecapture && !/site\s?capture/.test(low)) {
      const caps = (String(text).match(/\b[A-Z][a-zA-Z]{2,}\b/g) || []).filter((w) => !STOP.has(w.toLowerCase()) && !GENERIC.has(w.toLowerCase()));
      const terms = caps.join(" ") || (digits.length >= 3 ? digits : "");
      if (terms) { try { const sc = await toolSearchSitecapture({ query: terms }); if (sc && sc.count) { sitecapture = sc; parts.push("SITECAPTURE RESULTS:\n" + JSON.stringify(sc)); used.push("search_sitecapture"); } } catch (e) {} }
    }
  }

  return { context: parts.join("\n\n").slice(0, 8000), used, records, search, sitecapture };
}

// ── LOCAL answer builders (NO LLM) — WinMI's core "skill" so it works without Gemini ──────────
function fmtDT(s) { s = String(s || ""); if (!s) return ""; const d = s.slice(0, 10), t = s.slice(11, 16); return t ? (d + " " + t) : d; }
function fmtReport(records, lang) {
  const es = lang === "es";
  const body = records.map((r) => {
    if (!r || r.found === false || r.error) return null;
    const L = [];
    L.push("📋 " + (r.dl || "") + " — " + (r.customer || ""));
    if (r.address) L.push("📍 " + r.address + (r.phone ? ("  ·  ☎ " + r.phone) : ""));
    L.push((es ? "Etapa: " : "Project stage: ") + (r.dealStage || "—") + (r.systemKw ? ("  ·  " + r.systemKw + " kW") : "") + (r.ahj ? ("  ·  AHJ: " + r.ahj) : ""));
    (r.installations || []).forEach((it) => {
      L.push((es ? "🔧 Instalación " : "🔧 Install ") + (it.record || "") + ": " + (it.stage || "—") + (it.crew ? ("  ·  " + it.crew) : "") + (it.startDate ? ("  ·  " + (es ? "inicio " : "start ") + it.startDate) : "") + (it.completeDate ? ("  ·  " + (es ? "completado " : "done ") + it.completeDate) : ""));
      if (it.installNotes) L.push("   • " + it.installNotes);
      if (it.roofNotes) L.push("   • " + (es ? "Techo: " : "Roof: ") + it.roofNotes);
    });
    (r.serviceTickets || []).forEach((t) => {
      L.push((es ? "🛠 Servicio " : "🛠 Service ") + (t.ticket || "") + ": " + (t.status || "—") + (t.scheduledVisit ? ("  ·  " + (es ? "visita " : "visit ") + fmtDT(t.scheduledVisit)) : "") + (t.completedDate ? ("  ·  " + (es ? "completado " : "done ") + fmtDT(t.completedDate)) : "") + (t.tech ? ("  ·  " + t.tech) : ""));
      if (t.description) L.push("   • " + t.description);
    });
    const ins = r.inspection || {};
    if (ins.dealInspectionStage || ins.found) L.push((es ? "🔍 Inspección: " : "🔍 Inspection: ") + (ins.dealInspectionStage || ins.subRecordStage || (ins.found ? ((es ? "registro " : "record ") + ins.record) : (es ? "ninguna" : "none"))) + (ins.finalInspectionApproved ? ("  ·  " + (es ? "aprobada " : "approved ") + fmtDT(ins.finalInspectionApproved)) : ""));
    if (r.notes && r.notes.length) {
      L.push(es ? "📝 Notas recientes:" : "📝 Recent notes:");
      r.notes.slice(0, 5).forEach((n) => L.push("   • " + (n.time ? (n.time.slice(0, 10) + " — ") : "") + (n.content || n.title || "") + (n.author ? (" (" + n.author + ")") : "")));
    }
    if (r.zohoUrl) L.push("🔗 " + r.zohoUrl);
    return L.join("\n");
  }).filter(Boolean).join("\n\n———\n\n");
  const open = records.length > 1 ? (es ? "¡Claro! Esto es lo último de Zoho:\n\n" : "Sure! Here's the latest from Zoho:\n\n") : (es ? "¡Aquí tienes! 👇\n\n" : "Here you go! 👇\n\n");
  return open + body + (es ? "\n\n¿Necesitas algo más de este trabajo?" : "\n\nAnything else you need on this one?");
}
function fmtMatches(matches, lang) {
  const es = lang === "es";
  const list = matches.slice(0, 8).map((m) => "• " + (m.dl || "") + " — " + (m.customer || "") + (m.address ? ("  ·  📍 " + m.address) : "") + (m.stage ? ("  ·  " + m.stage) : "")).join("\n");
  return (es ? "Encontré estos proyectos — dime el DL# para el detalle completo:\n\n" : "I found these projects — tell me the DL# for the full detail:\n\n") + list;
}
function fmtSiteCapture(sc, lang) {
  const es = lang === "es";
  const list = (sc.projects || []).slice(0, 8).map((p) => "• " + (p.name || "") + (p.address ? ("  ·  📍 " + p.address) : "") + (p.status ? ("  ·  " + p.status) : "")).join("\n");
  return (es ? "No lo encontré en Zoho, pero esto salió en SiteCapture 📷:\n\n" : "I didn't find it in Zoho, but here's what SiteCapture has 📷:\n\n") + list;
}
function fmtSchema(lang) {
  const es = lang === "es";
  return (es ? "Así está organizado nuestro Zoho 👇\n\n" : "Here's how our Zoho is organized 👇\n\n") + ZOHO_GUIDE;
}
function fmtApp(lang) {
  const es = lang === "es";
  return (es ? "Esto es lo que puedes hacer en la app 👇\n\n" : "Here's what you can do in the app 👇\n\n") + APP_GUIDE;
}

// Compact, accurate guide to the app so WinMI can walk users through anything (fed as knowledge).
const APP_GUIDE = [
  "WINDMAR ITINERARY APP — what each tab does (be specific when guiding users):",
  "• Itinerary = home base. The 'Needs Attention' board shows LIVE crew updates from the field (tap one to open it in Zoho and change the stage), jobs stuck >3 days, tomorrow's visits, and inspections. 'Crew Board' = today by crew; 'Brigada Calendar' = the full calendar.",
  "• Coordinator = every job READY to schedule. Toggle 'By Type' / 'By Area'; By Area groups nearby jobs and gives a '🧭 Route' button that opens a multi-stop Google Maps trip. Click a job to Edit its stage/schedule or Add a note + photos (saves to Zoho). Search by DL#, customer, or address.",
  "• Projects = the whole Zoho pipeline by stage. Filter to '🔍 Inspections' (red = needs scheduling) and use 'Schedule Nearest Crew' to send the closest crew to a pending inspection. 'Open in Zoho' on each card.",
  "• Calendar = installs (⚡) + services (🔧) by crew and day. Views: Crew Grid / 🗺 Map (week or day, with Get Directions) / Month / List. Filter All / Installs / Service. Click a job to edit it or read the full work order.",
  "• Crews = live truck GPS for the install team + HQ. 'Emergency Dispatch Routing': type an address → closest crew + ETA.",
  "• Weather = 7-day forecast + safety alerts for FL job sites, LOTO de-energize steps, and bilingual site phrases.",
  "• SiteCapture = search project photos & details, or create a new SiteCapture project.",
  "• Crew Records = archive of crew status events (search/filter). Install Map = every completed install on a map with Get Directions.",
  "• Global: 🔔 notifications, 🌐 EN/ES toggle, 🌙 light/dark theme. To EDIT a job, open it in Coordinator or Calendar → Edit / Save / Add note. (WinMI itself is read-only.)",
].join("\n");

// WindMar's Zoho CRM structure — modules, key fields, and the real stage/status lifecycles, so
// WinMI understands the whole pipeline (not just one record). Surveyed from live Zoho metadata.
const ZOHO_GUIDE = [
  "WINDMAR ZOHO CRM STRUCTURE (org666151142) — use this to understand any project's data & lifecycle:",
  "• Deals = the project/customer master; every other record links to it. Pipeline field = Solar / Roofing / Service. Deal STAGE lifecycle (order): Information Gathering → Qualification → Proposal → Negotiation → Signed (Won) → Pre-Engineering → NTP → Site Visit → Engineering → Permitting → Install → Post-Installation → Utility → Finance → In Service → In Service - Complete. Service branch: Pre-Service → Post Service → Service Complete. Terminal: On Hold, Closed Lost. Key fields: Deal_Name, Stage, Pipeline, Sales_Person, Client_Coordinator, Authority_Having_Jurisdiction_AHJ, County1, Utility_Picklist, Permit_Submitted/Received_Date, Final_Inspection_Approved, System_Activation_Date.",
  "• Installation (links via `Deal`) = the install job. STAGE values: 'Permit Approved - Pending Roof/MSP/HOA/Umbrella', 'Pending Schedule' (=ready to put on the calendar), 'Pending Schedule - Batteries Needed', Scheduled, In Progress, 'Installation Repair Required', 'Installation Complete - Need QA', 'Solar Complete - Need MSP ASAP', Complete, 'QA Complete - Move To Final Inspection', and several 'On Hold - Need Financing/Roof/HOA'. Key fields: Installation_Team (crew), Installation_Start_Date, Installation_Complete_Date, Number_of_Days_Needed, MSP_Completion, BOM_Status (Pending / Ready / Uploaded in NetSuite).",
  "• Service_Ticket (links via `Associated_Deal`) = a service visit. Ticket_Status lifecycle: '1. Reported' → '2. Under review' → '3. Need Schedule' → '4. Scheduled' → '5. Need Reschedule' → '6. Tier 3/RMA/Warranty' → '7. Complete' → '8. Complete/Contacted' (plus 9-12 for more-info / financing / up-sales / quote). Key fields: Assigned_Technician (+ Visit_2/_3), Scheduled_Visit_1/2/3, Priority, Service_Type1, Area_of_Service, Ticket_Completion_Date.",
  "• Final_Inspectin (label 'Post Installation', links via `Deal`) = final inspection. Final_Inspection_Stage: 'Ready for QA', 'Ready to Schedule', 'Inspection Scheduled', 'Inspection Failed - Corrections/Plan Revision', 'Partial Approval', 'All Inspections Approved' (+ 'by VIP waiting BD confirmation'), 'Building Department Hold', 'On-Hold (Legal Action)'. Key fields: Final_Inspection_Scheduled, Final_Inspection_Approved.",
  "• Related modules: Roofing & Roofers (roofing jobs + crews; Deal Pipeline=Roofing), Permit & Engineering, Installation_Team/Installer (crew rosters that Installation_Team points to), Contacts/Accounts, and stage-change history modules (Installation_Stage_History, Final_Inspection_Stage_History).",
].join("\n");

// ---- handler ----------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  // GET diagnostic — confirms the Field HUB brain is reachable + Zoho wired (no secret exposed).
  if (req.method === "GET") {
    let brainReachable = false;
    try { const r = await fetchT(NEC_AI_URL, { method: "GET" }, 10000); brainReachable = !!(r && r.ok); } catch (e) {}
    const k = (process.env.ANTHROPIC_API_KEY || "").trim();
    return res.status(200).json({ ok: true, service: "assistant", geminiBrain: NEC_AI_URL, geminiReachable: brainReachable, hasZoho: hasZoho(),
      claudeKeyPresent: !!k, claudeKeyValid: /^sk-ant-/.test(k), claudeModel: MODEL,
      primaryBrain: /^sk-ant-/.test(k) ? "claude" : "gemini" });
  }
  if (req.method !== "POST") return res.status(200).json({ ok: false, error: "POST only" });

  try {
    // Parse the body safely — Vercel may hand us a string or an already-parsed object.
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const lang = body.lang === "es" ? "es" : "en";
    const messages = normalizeMessages(body.messages);
    if (!messages.length) return res.status(200).json({ ok: false, error: "no user message provided" });

    const question = messages[messages.length - 1].content;
    const history = messages.slice(0, -1).map((m) => ({ role: m.role, text: m.content }));

    // ── FILE MODE: a photo (image/*) OR a document (application/pdf) → read it with Claude
    // (vision for photos, document input for PDFs); Gemini fallback via the Field HUB nec-ai.
    const att = (body.image && body.image.data) ? body.image : ((body.file && body.file.data) ? body.file : null);
    if (att) {
      const isDoc = /pdf/i.test(att.mediaType || "");
      const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
      let answer = null, brain = "";
      if (/^sk-ant-/.test(apiKey)) { try { answer = await callClaudeVision(apiKey, question, att, history, lang); if (answer) brain = isDoc ? "claude-doc" : "claude-vision"; } catch (e) {} }
      if (!answer) { // Gemini fallback (nec-ai handles image + pdf via inline_data)
        try { const r = await fetchT(NEC_AI_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: { data: att.data, mimeType: att.mediaType || (isDoc ? "application/pdf" : "image/jpeg") }, question, lang }) }, 45000);
          if (r && r.ok) { const d = await r.json().catch(() => ({})); if (d && d.answer) { answer = stripFollowups(d.answer); brain = "gemini-vision"; } } } catch (e) {}
      }
      if (answer) return res.status(200).json({ ok: true, answer, used: ["file"], source: brain });
      return res.status(200).json({ ok: false, error: lang === "es" ? "No pude leer ese archivo ahora mismo — inténtalo de nuevo." : "I couldn't read that file just now — please try again." });
    }

    const ql = String(question).toLowerCase();

    // ── ANALYTICAL intent ("how many", totals, per-crew) MUST reach the agent (count_jobs) — never
    // a canned local answer. Detect it FIRST and skip the fuzzy project search entirely (that search
    // deep-fetches a random match into `found` and would short-circuit before the agent runs — the
    // old keyword router's core bug).
    const analytical = /\bhow many|how much|how often|number of|count(s|ed|ing)?|total(s|ed)?|tally|tallies|breakdown|per crew|by crew|each crew|which crew|how's .* doing|how is .* doing|most|fewest|least|busiest|average|avg|cu[aá]nt|cu[aá]nto|promedio\b/i.test(question);

    let used = [], records = [], search = null, sitecapture = null;
    if (!analytical) {
      ({ used, records, search, sitecapture } = await gatherContext(question));
    }
    const found = (records || []).filter((r) => r && r.found !== false && !r.error);

    // ── LOCAL-FIRST fast paths (instant, no LLM) — ONLY for clear, non-analytical data hits.
    if (found.length) return res.status(200).json({ ok: true, answer: fmtReport(found, lang), used: [...new Set(used)], source: "local" });
    if (search && Array.isArray(search.matches) && search.matches.length) return res.status(200).json({ ok: true, answer: fmtMatches(search.matches, lang), used: [...new Set(used)], source: "local" });
    if (sitecapture && sitecapture.count) return res.status(200).json({ ok: true, answer: fmtSiteCapture(sitecapture, lang), used: [...new Set(used)], source: "local" });

    // ── SMART BRAIN: Claude WITH TOOLS (search_projects, get_job_details, search_sitecapture,
    // count_jobs). It decides what to call — so WinMI answers ANY work question: lookups, searches,
    // and aggregate "how many …" analytics. Gemini (freeform) + friendly local are the fallbacks.
    let answer = null, brain = "", usedX = [...used];
    const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
    if (/^sk-ant-/.test(apiKey)) {
      try { const r = await callClaudeAgentic(apiKey, question, history, lang); if (r && r.answer) { answer = r.answer; brain = "claude"; usedX.push(...(r.used || [])); } } catch (e) {}
    }
    if (!answer) {
      // Gemini fallback (freeform, no tools). Keep the warm WinMI persona; its NEC brain still helps.
      const persona = lang === "es"
        ? "Eres WinMI, el asistente personal de WindMar Home: un droide cálido, animado y agudo — como un compañero de trabajo simpático. Ten una CONVERSACIÓN real: sé cercano y alentador, nunca aburrido ni robótico. Da respuestas DIRECTAS y útiles primero (sin relleno) y, cuando ayude, agrega una pregunta de seguimiento breve y amable en prosa normal. Conoces esta app a fondo (mira la GUÍA DE LA APP en tu conocimiento) y puedes guiar a cualquiera paso a paso. También respondes preguntas de código NEC/equipos. Eres de SOLO LECTURA: consultas datos pero nunca los cambias — si te piden editar/programar, explícalo con gusto y dilo que usen el botón Editar/Agregar nota en Coordinador o Calendario. Nunca inventes datos de proyectos; usa solo lo que está en tu conocimiento. Sé conciso y apto para móvil. Usa emojis con moderación. NO escribas una línea 'FOLLOWUPS:'."
        : "You are WinMI, WindMar Home's warm, upbeat personal assistant droid — like a sharp, friendly coworker. Have a REAL conversation: be personable and encouraging, never dull or robotic. Give DIRECT, useful answers first (no filler), then when it helps, add a short friendly follow-up question in plain prose. You know this app inside-out (see the APP GUIDE) and answer NEC/electrical/equipment questions. You are READ-ONLY: you look things up but never change data — if asked to edit/schedule, cheerfully point them to the Edit/Add-note button in the Coordinator or Calendar tab. Never invent project data. Keep it concise and mobile-friendly. Use emojis sparingly. Do NOT output a 'FOLLOWUPS:' line.";
      const q = persona + "\n\nUser question: " + question;
      try { const r = await callNecBrain(q, history, lang, ""); if (r.source !== "knowledge-fallback") { answer = stripFollowups(r.answer); brain = "gemini"; } } catch (e) {}
    }
    if (answer) return res.status(200).json({ ok: true, answer, used: [...new Set(usedX)], source: brain });

    // ── Both brains unavailable → last-resort LOCAL guides (schema / app), then a friendly note.
    if (/\b(stage|stages|status|statuses|pipeline|lifecycle|modules?|picklist|etapas?|estados?|flujo|proceso|m[oó]dulos?)\b/.test(ql)) return res.status(200).json({ ok: true, answer: fmtSchema(lang), used: ["zoho_guide"], source: "local" });
    if (/\b(how|where|which|what|c[oó]mo|d[oó]nde|qu[eé])\b/.test(ql) && /(app|tab|coordinator|calendar|schedule|route|map|weather|sitecapture|note|edit|dispatch|coordinador|calendario|programar|ruta|mapa|clima|nota|editar|pesta)/.test(ql)) return res.status(200).json({ ok: true, answer: fmtApp(lang), used: ["app_guide"], source: "local" });
    return res.status(200).json({ ok: true, source: "local-fallback", used: [...new Set(usedX)],
      answer: lang === "es"
        ? "Mi cerebro está ocupado ahora mismo 🙈 — inténtalo de nuevo en un momento. Mientras tanto puedo buscar cualquier proyecto al instante (dame un DL# o el nombre del cliente) o explicarte cómo usar la app."
        : "My brain is busy right now 🙈 — try again in a moment. Meanwhile I can still look up any project instantly (give me a DL# or the customer name) or explain how to use the app." });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
