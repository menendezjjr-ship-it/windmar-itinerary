// Itinerary-native Service_Ticket feeds for the Service & Monitoring dashboard + tickets tab.
// Uses the itinerary's RESILIENT shared Zoho token (_zoho.js: shared-store + force-refresh-retry +
// circuit breaker) so these feeds NEVER depend on the service-app's flakier token, which occasionally
// returns "Token refresh failed: Access Denied" and made the dashboard show a false "0 new".
//
//   GET /api/service-tickets?mode=recent    → newest-created tickets (the "new" panel)
//   GET /api/service-tickets?mode=closed    → recently-completed tickets
//   GET /api/service-tickets?mode=backlog   → tickets that need scheduling
//   GET /api/service-tickets?month=<m>&year=<y> → tickets scheduled that month (any of 3 visits)
//
// Response: { ok:true, mode, count, records:[ {id,ticketNo,customer,phone,city,county,address,team,
//   status,fieldStatus,priority,serviceType,systemType,description,area,techsRequired,createdTime,
//   modifiedTime,closedTime,startDate,startTime,visits} ] }  |  { ok:false, transient?, error, records:[] }
import { zohoFetch, hasZohoCreds, ZOHO_API_DOMAIN, ZOHO_API_VERSION } from "./_zoho.js";

const API = `${ZOHO_API_DOMAIN}/crm/${ZOHO_API_VERSION}`;
const TZ = "-04:00"; // Florida (matches zoho-jobs)
const FIELDS = [
  "Name","First_Name","Last_Name","Business_Name","Phone_1","Alt_Phone","City","County","Street","State",
  "Assigned_Technician","Assigned_Technician_Visit_2","Assigned_Technician_Visit_3","Ticket_Status","Field_Status",
  "Priority","Type_of_Service","Service_Type1","Service_Description","Area_of_Service","Number_of_Techs_Required",
  "Scheduled_Visit_1","Scheduled_Visit_2","Scheduled_Visit_3","Date_Complete","Created_Time","Modified_Time",
].join(",");

function splitDT(dt) {
  if (!dt) return { date: "", time: "" };
  const s = String(dt);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (m) return { date: m[1], time: m[2] };
  const d = s.match(/^\d{4}-\d{2}-\d{2}/);
  return { date: d ? d[0] : "", time: "" };
}
const techName = (t) => (t && t.name ? String(t.name) : "");

function mapRow(r) {
  const first = (r.First_Name || "").trim(), last = (r.Last_Name || "").trim();
  const customer = (first || last) ? (first + " " + last).trim() : (r.Business_Name || "").trim();
  const address = [r.Street, r.City, r.State].filter(Boolean).join(", ");
  const sv1 = splitDT(r.Scheduled_Visit_1);
  const visits = [];
  [[r.Scheduled_Visit_1, r.Assigned_Technician], [r.Scheduled_Visit_2, r.Assigned_Technician_Visit_2], [r.Scheduled_Visit_3, r.Assigned_Technician_Visit_3]]
    .forEach(([dt, tech]) => { if (dt) { const s = splitDT(dt); visits.push({ date: s.date, time: s.time, tech: techName(tech) }); } });
  const serviceType = Array.isArray(r.Type_of_Service) ? r.Type_of_Service.join(", ") : (r.Type_of_Service || "");
  return {
    id: String(r.id || ""),
    ticketNo: (r.Name || "").trim(),
    customer,
    phone: (r.Phone_1 || r.Alt_Phone || "").toString().trim(),
    city: (r.City || "").trim(),
    county: (r.County || "").toString().trim(),
    address,
    team: techName(r.Assigned_Technician),
    status: (r.Ticket_Status || "").trim(),
    fieldStatus: (r.Field_Status || "").toString().trim(),
    priority: (r.Priority || "").toString().trim(),
    serviceType,
    systemType: (r.Service_Type1 || "").toString().trim(),
    description: (r.Service_Description || "").trim(),
    area: (r.Area_of_Service || "").toString().trim(),
    techsRequired: (r.Number_of_Techs_Required == null ? "" : String(r.Number_of_Techs_Required)),
    createdTime: r.Created_Time || "",
    modifiedTime: r.Modified_Time || "",
    closedTime: r.Date_Complete ? String(r.Date_Complete) : "",
    startDate: sv1.date,
    startTime: sv1.time,
    visits,
  };
}

// Plain records list (no criteria) — for newest-created / newest-modified pulls.
async function list({ sortBy, sortOrder, perPage, page }) {
  const url = `${API}/Service_Ticket?fields=${encodeURIComponent(FIELDS)}&per_page=${perPage || 100}&page=${page || 1}&sort_by=${sortBy || "Created_Time"}&sort_order=${sortOrder || "desc"}`;
  const r = await zohoFetch(url);
  if (r.status === 204) return [];
  if (!r.ok) throw new Error(`Zoho ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  return (j.data || []).map(mapRow);
}
// Criteria search (for scheduled-month feeds).
async function search(criteria, { perPage, pages } = {}) {
  const all = [];
  for (let p = 1; p <= (pages || 3); p++) {
    const url = `${API}/Service_Ticket/search?criteria=${encodeURIComponent(criteria)}&fields=${encodeURIComponent(FIELDS)}&per_page=${perPage || 200}&page=${p}`;
    const r = await zohoFetch(url);
    if (r.status === 204) break;
    if (!r.ok) throw new Error(`Zoho search ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    all.push(...(j.data || []).map(mapRow));
    if (!j.info || !j.info.more_records) break;
  }
  return all;
}

const isComplete = (s) => /^\s*(7|8)\./.test(s) || /service complete/i.test(s);      // 7. Complete, 8. Complete/Contacted, 11. Service Complete…
const isBacklog  = (s) => /need\s*re-?\s*schedul/i.test(s) || /need\s+schedul/i.test(s) || /not\s+scheduled/i.test(s) || /^tentative/i.test(s);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=60");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!hasZohoCreds()) return res.status(200).json({ ok: false, configured: false, records: [] });

  const mode = String(req.query.mode || "").toLowerCase();
  const month = parseInt(req.query.month, 10), year = parseInt(req.query.year, 10);
  try {
    let records = [];
    if (mode === "recent") {
      records = await list({ sortBy: "Created_Time", sortOrder: "desc", perPage: 60, page: 1 });
    } else if (mode === "closed") {
      const recent = await list({ sortBy: "Modified_Time", sortOrder: "desc", perPage: 200, page: 1 });
      records = recent.filter((r) => isComplete(r.status)).slice(0, 100);
    } else if (mode === "backlog") {
      const recent = await list({ sortBy: "Modified_Time", sortOrder: "desc", perPage: 200, page: 1 });
      records = recent.filter((r) => isBacklog(r.status));
    } else if (month >= 1 && month <= 12 && year > 2000) {
      const mm = String(month).padStart(2, "0");
      const start = `${year}-${mm}-01`;
      const end = `${year}-${mm}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
      const crit = `((Scheduled_Visit_1:between:${start}T00:00:00${TZ},${end}T23:59:59${TZ})or(Scheduled_Visit_2:between:${start}T00:00:00${TZ},${end}T23:59:59${TZ})or(Scheduled_Visit_3:between:${start}T00:00:00${TZ},${end}T23:59:59${TZ}))`;
      records = await search(crit, { perPage: 200, pages: 3 });
    } else {
      return res.status(200).json({ ok: false, error: "unknown mode", records: [] });
    }
    return res.status(200).json({ ok: true, mode: mode || ("month:" + month + "-" + year), count: records.length, records });
  } catch (e) {
    // transient=true so the client keeps prior data + retries (mirrors the service-app contract)
    return res.status(200).json({ ok: false, transient: true, error: String((e && e.message) || e), records: [] });
  }
}
