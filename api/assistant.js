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
const MODEL = process.env.ASSISTANT_MODEL || "claude-sonnet-5";

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
  return toks.filter((t) => t.length >= 2 && !STOP.has(t)).join(" ").trim();
}

// Zoho word-search ANDs every word, so a full sentence rarely matches. Build ordered query
// candidates (proper nouns first, then each significant token) and return the FIRST that hits.
async function smartProjectSearch(text) {
  const cands = [];
  const caps = (String(text).match(/\b[A-Z][a-zA-Z]{2,}\b/g) || []).filter((w) => !STOP.has(w.toLowerCase()));
  if (caps.length > 1) cands.push(caps.join(" "));
  caps.slice().sort((a, b) => b.length - a.length).forEach((w) => cands.push(w));
  const stripped = searchTermsFrom(text);
  if (stripped) cands.push(stripped);
  stripped.split(" ").filter((t) => t.length >= 4).sort((a, b) => b.length - a.length).forEach((t) => cands.push(t));
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
    installNotes: (it.Installation_Notes || "").trim(),
    roofNotes: (it.Roof_Notes || "").trim(),
    ahjNotes: (it.AHJ_Specific_Install_Notes || "").trim(),
  }));

  // Also pull CRM Notes attached to the Installation record(s) and merge with the Deal's notes.
  let notes = Array.isArray(dealNotes) ? dealNotes.slice() : [];
  const instIds = instArr.map((it) => it.id).filter(Boolean).slice(0, 2);
  const instNoteSets = await Promise.all(instIds.map((iid) => fetchNotes("Installation", iid, token)));
  instNoteSets.forEach((set) => { notes = notes.concat(set); });
  const seen = new Set();
  notes = notes.filter((n) => { const k = (n.time || "") + "|" + (n.content || "").slice(0, 40); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(b.time || "").localeCompare(String(a.time || ""))).slice(0, 15);

  const tickets = (Array.isArray(services) ? services : []).map((s) => ({
    ticket: s.Name || "",
    status: (s.Ticket_Status || "").trim(),
    scheduledVisit: s.Scheduled_Visit_1 || "",
    completedDate: s.Ticket_Completion_Date || s.Date_Complete || "",
    type: Array.isArray(s.Type_of_Service) ? s.Type_of_Service.join(", ") : (s.Type_of_Service || ""),
    description: (s.Service_Description || "").trim(),
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
];

async function runTool(name, input) {
  try {
    if (name === "search_projects") return await toolSearchProjects(input);
    if (name === "get_job_details") return await toolGetJobDetails(input);
    if (name === "search_sitecapture") return await toolSearchSitecapture(input);
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
  return String(data.answer || "");
}

// The NEC Assistant appends a "FOLLOWUPS: ..." line for the Field HUB's chip UI — strip it here.
function stripFollowups(s) { return String(s || "").replace(/\n*FOLLOWUPS:.*$/is, "").trim(); }

// Best-effort: pull live project data relevant to the question, formatted as knowledge context.
async function gatherContext(text) {
  const used = [], parts = [];
  if (!hasZoho()) return { context: "", used };
  const low = String(text || "").toLowerCase();

  // (a) Explicit DL/RDL/RL/MSP numbers → deep lookup each (full record incl. notes).
  const uniqDls = [...new Set((String(text).match(/\b(?:RDL|RL|DL|MSP)\s?\d{3,}\b/ig) || []).map(normDL))].slice(0, 3);
  if (uniqDls.length) {
    const jobs = await Promise.all(uniqDls.map((dl) => toolGetJobDetails({ dl }).catch((e) => ({ error: String((e && e.message) || e) }))));
    jobs.forEach((r, i) => parts.push("PROJECT " + uniqDls[i] + " (full Zoho record):\n" + JSON.stringify(r)));
    used.push("get_job_details");
  }

  // (b) SiteCapture, when asked.
  if (/site\s?capture/.test(low)) {
    try { const r = await toolSearchSitecapture({ query: searchTermsFrom(text) || text }); parts.push("SITECAPTURE RESULTS:\n" + JSON.stringify(r)); used.push("search_sitecapture"); } catch (e) {}
  }

  // (c) No DL, but it's clearly about a specific project (by name/address/status/notes/...) →
  //     search Zoho, then DEEP-fetch the top match(es) so WinMI gets notes + status, not one-liners.
  const projectish = /(status|note|report|update|stage|schedule|ready|pending|complete|past ?due|inspection|permit|bom|plan|install|service|crew|deal|project|job|customer|address|phone|when|where|who|estado|nota|reporte|etapa|program|list[oa]|pendiente|complet|inspecci|permiso|instalaci|servicio|cuadrilla|cliente|direcci|proyecto|trabajo)/i;
  if (!uniqDls.length && projectish.test(low) && searchTermsFrom(text).length >= 2) {
    try {
      const { res, query } = await smartProjectSearch(text);
      parts.push('PROJECT SEARCH for "' + query + '":\n' + JSON.stringify(res));
      used.push("search_projects");
      const dls = (res && Array.isArray(res.matches) ? res.matches : []).map((m) => normDL(m.dl)).filter((d) => /^(?:RDL|RL|DL|MSP|S)\d{2,}$/.test(d));
      const top = [...new Set(dls)].slice(0, 2);
      if (top.length) {
        const deep = await Promise.all(top.map((dl) => toolGetJobDetails({ dl }).catch((e) => ({ error: String((e && e.message) || e) }))));
        deep.forEach((r, i) => parts.push("PROJECT " + top[i] + " (full Zoho record):\n" + JSON.stringify(r)));
        if (used.indexOf("get_job_details") < 0) used.push("get_job_details");
      }
    } catch (e) {}
  }

  return { context: parts.join("\n\n").slice(0, 14000), used };
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
    return res.status(200).json({ ok: true, service: "assistant", brain: NEC_AI_URL, brainReachable, hasZoho: hasZoho() });
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

    // Enrich with live project data (best-effort). Always include the APP GUIDE so WinMI can
    // walk users through the app; project data (if any) follows.
    const { context, used } = await gatherContext(question);
    const knowledge = APP_GUIDE + (context ? "\n\n--- LIVE PROJECT DATA ---\n" + context : "");
    const persona = lang === "es"
      ? "Eres WinMI, el asistente personal de WindMar Home: un droide cálido, animado y agudo — como un compañero de trabajo simpático. Ten una CONVERSACIÓN real: sé cercano y alentador, nunca aburrido ni robótico. Da respuestas DIRECTAS y útiles primero (sin relleno) y, cuando ayude, agrega una pregunta de seguimiento breve y amable en prosa normal. Conoces esta app a fondo (mira la GUÍA DE LA APP en tu conocimiento) y puedes guiar a cualquiera paso a paso. También respondes preguntas de código NEC/equipos. Eres de SOLO LECTURA: consultas datos pero nunca los cambias — si te piden editar/programar, explícalo con gusto y dilo que usen el botón Editar/Agregar nota en Coordinador o Calendario. Nunca inventes datos de proyectos; usa solo lo que está en tu conocimiento. Cuando te pregunten por un trabajo o proyecto específico, da un reporte claro con los DATOS EN VIVO de tu conocimiento — su etapa/estado, fechas clave, cuadrilla, dirección, tickets de servicio, inspección y las NOTAS más recientes (resúmelas). Si los datos no incluyen el proyecto, dilo claramente y pide el DL# o el nombre exacto del cliente. Dos reglas de exactitud: (1) el técnico de un ticket de servicio es SOLO el campo 'tech' del ticket — si está vacío, no nombres a nadie y NUNCA asumas que la cuadrilla de instalación es el técnico de servicio; (2) para el estado de inspección usa el nivel del deal ('dealInspectionStage'/'finalInspectionApproved'), no el sub-registro. Sé conciso y apto para móvil. Usa emojis con moderación. NO escribas una línea 'FOLLOWUPS:'."
      : "You are WinMI, WindMar Home's warm, upbeat personal assistant droid — like a sharp, friendly coworker. Have a REAL conversation: be personable and encouraging, never dull or robotic. Give DIRECT, useful answers first (no filler), then when it helps, add a short friendly follow-up question in plain prose. You know this app inside-out (see the APP GUIDE in your knowledge) and can walk anyone through how to do anything in it. You also answer NEC/electrical/equipment questions. You are READ-ONLY: you look things up but never change data — if asked to edit/schedule, cheerfully explain that and point them to the Edit/Add-note button in the Coordinator or Calendar tab. Never invent project data; use only what's in your knowledge/tools. When someone asks about a specific job or project, give a clear report straight from the LIVE PROJECT DATA in your knowledge — its stage/status, key dates, crew, address, service tickets, inspection, and the most recent NOTES (summarize them). If the data does not contain the project, say so plainly and ask for the DL# or the exact customer name. Two accuracy rules: (1) a service ticket's technician is ONLY the ticket's own 'tech' field — if that's blank, don't name one and NEVER assume the install crew is the service tech; (2) for inspection status, use the deal-level 'dealInspectionStage'/'finalInspectionApproved' — not the sub-record — as the real status. Keep it concise and mobile-friendly. Use emojis sparingly. Do NOT output a 'FOLLOWUPS:' line.";
    const q = persona + "\n\nUser question: " + question;

    let answer;
    try { answer = stripFollowups(await callNecBrain(q, history, lang, knowledge)); }
    catch (e) { return res.status(200).json({ ok: false, error: "assistant brain unavailable: " + String((e && e.message) || e) }); }

    return res.status(200).json({ ok: true, answer: answer || (lang === "es" ? "Lo siento, no tengo una respuesta a eso." : "Sorry, I don't have an answer for that."), used: [...new Set(used)] });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
