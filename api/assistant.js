// /api/assistant.js — "Sunny", the WindMar Itinerary READ-ONLY AI assistant.
//
// Contract:
//   POST { messages: [{role:"user"|"assistant", content:"..."}], lang?: "en"|"es" }
//   ->  200 { ok:true, answer:"<text>", used:["tool",...] }              on success
//       200 { ok:false, configured:false, error:"AI key not set" }        if ANTHROPIC_API_KEY missing
//       200 { ok:false, error:"..." }                                     on any failure
//   OPTIONS -> 200 (CORS preflight). Never throws an unhandled 500 — everything is wrapped.
//
// Sunny answers coordinator/crew questions about WindMar solar/roofing PROJECTS by looking up
// LIVE data in Zoho CRM + SiteCapture via three READ-ONLY tools. It NEVER edits/schedules anything.
//
// Env vars:
//   ANTHROPIC_API_KEY  (required)  — Anthropic Messages API key
//   ASSISTANT_MODEL    (optional)  — default "claude-sonnet-5"
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

export const config = { maxDuration: 30 };

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
  const instFields = "Name,Stage,Installation_Start_Date,Installation_Complete_Date,Installation_Team,Installation_Notes";
  const svcFields = "Name,Ticket_Status,Scheduled_Visit_1,Type_of_Service,Service_Description,Assigned_Technician,Priority";
  const [installs, services, inspections] = await Promise.all([
    zohoSearch("Installation", `criteria=${encodeURIComponent(`(Deal:equals:${dealId})`)}&fields=${encodeURIComponent(instFields)}&per_page=10`, token).catch((e) => ({ __err: String(e && e.message || e) })),
    zohoSearch("Service_Ticket", `criteria=${encodeURIComponent(`(Associated_Deal:equals:${dealId})`)}&fields=${encodeURIComponent(svcFields)}&per_page=25`, token).catch((e) => ({ __err: String(e && e.message || e) })),
    zohoSearch("Final_Inspectin", `criteria=${encodeURIComponent(`(Deal:equals:${dealId})`)}&fields=${encodeURIComponent("Name")}&per_page=10`, token).catch((e) => ({ __err: String(e && e.message || e) })),
  ]);

  const install = Array.isArray(installs) && installs[0] ? {
    stage: installs[0].Stage || "",
    startDate: installs[0].Installation_Start_Date || "",
    completeDate: installs[0].Installation_Complete_Date || "",
    crew: lookup(installs[0].Installation_Team) || "",
    notes: (installs[0].Installation_Notes || "").trim(),
  } : null;

  const tickets = Array.isArray(services) ? services.map((s) => ({
    ticket: s.Name || "",
    status: (s.Ticket_Status || "").trim(),
    scheduledVisit: s.Scheduled_Visit_1 || "",
    type: Array.isArray(s.Type_of_Service) ? s.Type_of_Service.join(", ") : (s.Type_of_Service || ""),
    description: (s.Service_Description || "").trim(),
    tech: lookup(s.Assigned_Technician) || "",
    priority: s.Priority || "",
  })) : [];

  const inspection = Array.isArray(inspections) && inspections[0]
    ? { record: inspections[0].Name || "", found: true }
    : { found: false };

  return {
    found: true,
    dl: p.num || dl,
    customer: p.customer || deal.Deal_Name || "",
    address,
    ahj: lookup(deal.Authority_Having_Jurisdiction_AHJ) || "",
    dealStage: deal.Stage || "",
    systemKw: (deal.System_Size_kW1 != null && deal.System_Size_kW1 !== 0) ? deal.System_Size_kW1 : null,
    install,
    serviceTickets: tickets,
    inspection,
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
    "You are Sunny, WindMar Home's friendly, upbeat futuristic assistant droid. ☀️🤖",
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

async function callAnthropic(apiKey, messages, system) {
  const r = await fetchT(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1400, system, tools: TOOLS, messages }),
  }, 30000);
  if (!r) throw new Error("Anthropic request timed out");
  const data = await r.json();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(data && data.error && data.error.message) || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// ---- handler ----------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  // GET diagnostic — confirms whether this deployment can see the key (no secret exposed).
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true, service: "assistant",
      hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
      anthropicKeyLen: (process.env.ANTHROPIC_API_KEY || "").length,
      anthropicKeyLenTrimmed: (process.env.ANTHROPIC_API_KEY || "").trim().length,
      looksAnthropic: /^sk-ant-/.test((process.env.ANTHROPIC_API_KEY || "").trim()),
      model: MODEL,
      hasZoho: !!process.env.ZOHO_REFRESH_TOKEN,
      envMatches: Object.keys(process.env).filter((k) => /ANTHROPIC|CLAUDE/i.test(k)),
    });
  }
  if (req.method !== "POST") return res.status(200).json({ ok: false, error: "POST only" });

  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim(); // trim stray whitespace/newline from the env value
  if (!apiKey) return res.status(200).json({ ok: false, configured: false, error: "AI key not set" });

  try {
    // Parse the body safely — Vercel may hand us a string or an already-parsed object.
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const lang = body.lang === "es" ? "es" : "en";
    const messages = normalizeMessages(body.messages);
    if (!messages.length) return res.status(200).json({ ok: false, error: "no user message provided" });

    const system = systemPrompt(lang);
    const used = [];

    // Tool-use loop, capped at 5 iterations.
    for (let iter = 0; iter < 5; iter++) {
      const data = await callAnthropic(apiKey, messages, system);
      const blocks = Array.isArray(data.content) ? data.content : [];

      if (data.stop_reason === "tool_use") {
        const toolUses = blocks.filter((b) => b && b.type === "tool_use");
        // Append the assistant's turn (tool_use blocks) verbatim.
        messages.push({ role: "assistant", content: blocks });
        // Execute each tool and collect matching tool_result blocks.
        const results = [];
        for (const tu of toolUses) {
          if (tu.name) used.push(tu.name);
          const out = await runTool(tu.name, tu.input || {});
          results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 8000) });
        }
        messages.push({ role: "user", content: results });
        continue; // ask the model again with the tool results
      }

      // Final turn — join the text blocks.
      const answer = blocks.filter((b) => b && b.type === "text").map((b) => b.text).join("").trim();
      return res.status(200).json({ ok: true, answer: answer || (lang === "es" ? "Lo siento, no tengo una respuesta." : "Sorry, I don't have an answer for that."), used: [...new Set(used)] });
    }

    // Hit the iteration cap — make one last non-tool call for a text answer.
    try {
      const finalData = await callAnthropic(apiKey, messages, system);
      const blocks = Array.isArray(finalData.content) ? finalData.content : [];
      const answer = blocks.filter((b) => b && b.type === "text").map((b) => b.text).join("").trim();
      return res.status(200).json({ ok: true, answer: answer || (lang === "es" ? "Necesito más detalles para ayudarte." : "I need a bit more detail to help."), used: [...new Set(used)] });
    } catch (e) {
      return res.status(200).json({ ok: true, answer: lang === "es" ? "Estoy teniendo problemas para completar esa búsqueda. Intenta de nuevo." : "I'm having trouble completing that lookup. Please try again.", used: [...new Set(used)] });
    }
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
