// /api/sitecapture.js
// BROWSE: falls back to the WindMar Service app proxy (no creds, but no search).
// SEARCH + CREATE: use the direct SiteCapture API — requires a valid SiteCapture
//   login. Set SITECAPTURE_USER + SITECAPTURE_PASS (your SiteCapture login) in
//   Vercel, OR Site_Capture_Key = base64("user:pass").
const PROXY = process.env.SITECAPTURE_PROXY || "https://windmar-service-app.vercel.app/api/sitecapture";
const FIXED = process.env.SITECAPTURE_API_KEY || "zapier-api-4320";
function b64(s) { return Buffer.from(s).toString("base64"); }

// Build the Basic-auth header from whichever credential env is set.
function buildBasic() {
  if (process.env.SITECAPTURE_USER && process.env.SITECAPTURE_PASS) return "Basic " + b64(process.env.SITECAPTURE_USER + ":" + process.env.SITECAPTURE_PASS);
  if (process.env.Site_Capture_Key) { const k = process.env.Site_Capture_Key.trim(); return k.toLowerCase().startsWith("basic ") ? k : (k.indexOf(":") >= 0 ? "Basic " + b64(k) : "Basic " + k); }
  return null;
}
function mapList(arr) {
  return (arr || []).slice(0, 80).map((p) => ({
    id: String(p.id || p.project_id || ""),
    name: p.display_line1 || p.name || p.project_name || p.title || ("Project " + (p.id || "")),
    address: p.display_line2 || p.address || p.site_address || "",
    owner: p.display_line3 || p.assigned_user || p.owner || "",
    status: (p.status || p.project_status || "").toString(),
    template: p.template_name || p.template || "",
    updated: p.display_line4 || p.last_updated || p.modified_date || "",
    template_key: p.template_key || "",
  }));
}
function templatesOf(projects) {
  const t = {}; projects.forEach((p) => { if (p.template_key) t[p.template_key] = p.template || p.template_key; });
  return Object.keys(t).map((k) => ({ key: k, name: t[k] }));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=60");
  try {
    // Diagnostic — tests the credentials against a simple read. Leaks no secrets.
    if (req.method === "GET" && req.query.diag) {
      const basic = buildBasic();
      const src = (process.env.SITECAPTURE_USER && process.env.SITECAPTURE_PASS) ? "SITECAPTURE_USER/PASS" : (process.env.Site_Capture_Key ? "Site_Capture_Key" : "none");
      if (!basic) return res.status(200).json({ diag: true, authSource: "none", note: "No SiteCapture creds set on this project" });
      try {
        const r = await fetch("https://api.sitecapture.com/customer_api/2_0/projects?max=1", { headers: { Authorization: basic, "API_KEY": FIXED, Accept: "application/json" } });
        const txt = await r.text();
        return res.status(200).json({ diag: true, authSource: src, apiKeyUsed: FIXED, userLen: (process.env.SITECAPTURE_USER || "").length, passLen: (process.env.SITECAPTURE_PASS || "").length, status: r.status, ok: r.ok, body: txt.slice(0, 180) });
      } catch (e) { return res.status(200).json({ diag: true, authSource: src, error: String(e) }); }
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      if (!body.template_key) return res.status(200).json({ ok: false, error: "template_key required" });
      const basic = buildBasic();
      if (!basic) return res.status(200).json({ ok: false, needsAuth: true, error: "Add SITECAPTURE_USER + SITECAPTURE_PASS in Vercel to create projects." });
      const payload = { template_key: body.template_key };
      if (body.client_id) payload.client_id = body.client_id;
      const r = await fetch("https://api.sitecapture.com/customer_api/1_0/project", {
        method: "POST", headers: { Authorization: basic, "API_KEY": FIXED, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt }; }
      if (r.status === 401) return res.status(200).json({ ok: false, needsAuth: true, status: 401, error: "SiteCapture rejected the login (401). Set a valid SITECAPTURE_USER + SITECAPTURE_PASS in Vercel." });
      if (!r.ok) return res.status(200).json({ ok: false, status: r.status, error: (d.errors ? d.errors.join("; ") : txt.slice(0, 200)) });
      return res.status(200).json({ ok: true, id: String(d.id || d.project_id || (d.project && d.project.id) || ""), project: d });
    }

    const q = (req.query.q || "").toString().slice(0, 80);
    const basic = buildBasic();

    // READS via the WindMar service-app proxy — it holds the working SiteCapture
    // login AND supports search through its `q` param (forwards &search=&exact_text=false).
    let projects = [], ok = false;
    try {
      const u = PROXY + "?path=projects&offset=0" + (q ? ("&q=" + encodeURIComponent(q)) : "");
      const r = await fetch(u, { headers: { Accept: "application/json" } });
      if (r.ok) {
        const body = await r.json();
        const arr = Array.isArray(body) ? body : (body.data || body.projects || body.results || []);
        projects = mapList(arr);
        ok = true;
      }
    } catch (e) { /* leave ok=false */ }

    // CREATE still needs this project's own SiteCapture login (the proxy can't create).
    // Validate it with a tiny direct read so the UI knows whether Create will work.
    let canCreate = false;
    if (basic) {
      try {
        const cr = await fetch("https://api.sitecapture.com/customer_api/2_0/projects?max=1", { headers: { Authorization: basic, "API_KEY": FIXED, Accept: "application/json" } });
        canCreate = cr.ok;
      } catch (e) { /* canCreate stays false */ }
    }

    return res.status(200).json({ configured: true, ok, source: "proxy", searchOk: ok, canCreate, count: projects.length, projects, templates: templatesOf(projects), note: canCreate ? "" : "Create a project needs valid SITECAPTURE_USER + SITECAPTURE_PASS on this Vercel project." });
  } catch (e) {
    return res.status(200).json({ configured: true, ok: false, error: String(e), projects: [] });
  }
}
