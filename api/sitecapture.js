// /api/sitecapture.js — Vercel serverless proxy for SiteCapture (auto-authenticated server-side).
// SiteCapture requires Basic auth (username:password) + an API_KEY header. The single
// Site_Capture_Key env var can be interpreted several ways, so we try each strategy and use
// whichever the API accepts. Best practice: set SITECAPTURE_USER + SITECAPTURE_PASS.
function b64(s){ return Buffer.from(s).toString("base64"); }
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
  const FIXED = process.env.SITECAPTURE_API_KEY || "zapier-api-4320";
  const key = (process.env.Site_Capture_Key || process.env.SITECAPTURE_KEY || "").trim();
  const cands = [];
  if (process.env.SITECAPTURE_USER && process.env.SITECAPTURE_PASS) {
    cands.push({ label: "user_pass", headers: { Authorization: "Basic " + b64(process.env.SITECAPTURE_USER + ":" + process.env.SITECAPTURE_PASS), API_KEY: FIXED } });
  }
  if (key) {
    const asBasic = key.toLowerCase().startsWith("basic ") ? key : (key.indexOf(":") >= 0 ? "Basic " + b64(key) : "Basic " + key);
    cands.push({ label: "key_basic", headers: { Authorization: asBasic, API_KEY: FIXED } });
    cands.push({ label: "key_as_apikey", headers: { API_KEY: key } });
    cands.push({ label: "key_apikey_plus_fixedbasic", headers: { API_KEY: key, Authorization: "Basic " + b64("api:" + key) } });
    cands.push({ label: "key_bearer", headers: { Authorization: "Bearer " + key, API_KEY: FIXED } });
  }
  if (!cands.length) return res.status(200).json({ configured: false, ok: false, projects: [] });
  const base = "https://api.sitecapture.com";
  async function attempt(path, init) {
    const tried = [];
    for (const c of cands) {
      let r;
      try { r = await fetch(base + path, Object.assign({}, init, { headers: Object.assign({ "Content-Type": "application/json" }, (init && init.headers) || {}, c.headers) })); }
      catch (e) { tried.push({ s: c.label, status: "ERR" }); continue; }
      if (r.status !== 401 && r.status !== 403) return { r: r, label: c.label, tried: tried };
      tried.push({ s: c.label, status: r.status });
    }
    return { r: null, label: null, tried: tried };
  }
  try {
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      if (!body.template_key) return res.status(200).json({ ok: false, error: "template_key required" });
      const a = await attempt("/customer_api/1_0/project", { method: "POST", body: JSON.stringify({ template_key: body.template_key }) });
      if (!a.r) return res.status(200).json({ ok: false, error: "auth failed (401/403)", tried: a.tried });
      const txt = await a.r.text(); let data; try { data = JSON.parse(txt); } catch (e) { data = { raw: txt }; }
      if (!a.r.ok) return res.status(200).json({ ok: false, status: a.r.status, error: (data.errors ? data.errors.join("; ") : txt.slice(0, 200)) });
      return res.status(200).json({ ok: true, id: String(data.id || data.project_id || (data.project && data.project.id) || ""), auth: a.label });
    }
    const q = (req.query.q || "").toString().slice(0, 80);
    const a = await attempt("/customer_api/2_0/projects?max=24" + (q ? ("&search=" + encodeURIComponent(q)) : ""), {});
    if (!a.r) return res.status(200).json({ configured: true, ok: false, error: "auth failed (401/403)", tried: a.tried, projects: [] });
    if (!a.r.ok) { const t = await a.r.text(); return res.status(200).json({ configured: true, ok: false, status: a.r.status, error: t.slice(0, 200), tried: a.tried, projects: [] }); }
    const body = await a.r.json();
    const arr = Array.isArray(body) ? body : (body.projects || body.data || []);
    const projects = arr.map((p) => ({
      id: String(p.id || p.project_id || p.key || ""),
      name: p.name || p.project_name || p.template_name || ("Project " + (p.id || "")),
      status: (p.status || "").toString(), address: p.address || p.location || "",
      owner: p.assigned_user || p.owner || p.created_by || p.client_name || "",
      template: p.template_name || p.template || "", template_key: p.template_key || "",
      updated: p.last_updated || p.date_updated || p.updated || p.last_updated_date || "",
    }));
    const tmap = {}; projects.forEach((p) => { if (p.template_key) tmap[p.template_key] = p.template || p.template_key; });
    const templates = Object.keys(tmap).map((k) => ({ key: k, name: tmap[k] }));
    return res.status(200).json({ configured: true, ok: true, count: projects.length, projects, templates, auth: a.label });
  } catch (e) {
    return res.status(200).json({ configured: true, ok: false, error: String(e), projects: [] });
  }
}
