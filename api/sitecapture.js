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

    // Templates list — the valid template_keys for THIS portal. Tries the known
    // SiteCapture customer_api template endpoints and returns the first that works.
    if (req.method === "GET" && req.query.path === "templates") {
      const basic = buildBasic();
      if (!basic) return res.status(200).json({ ok: false, needsAuth: true, templates: [] });
      const H = { Authorization: basic, "API_KEY": FIXED, Accept: "application/json" };
      const cands = req.query.probe ? [
        "https://api.sitecapture.com/customer_api/2_0/templates",
        "https://api.sitecapture.com/customer_api/1_0/templates",
        "https://api.sitecapture.com/customer_api/2_0/template",
        "https://api.sitecapture.com/customer_api/1_0/template",
        "https://api.sitecapture.com/customer_api/2_0/forms",
        "https://api.sitecapture.com/customer_api/2_0/project_templates",
      ] : ["https://api.sitecapture.com/customer_api/2_0/templates"];
      const tried = [];
      for (const u of cands) {
        try {
          const r = await fetch(u, { headers: H });
          const txt = await r.text();
          tried.push({ url: u, status: r.status, sample: txt.slice(0, 140) });
          if (r.ok) {
            let d; try { d = JSON.parse(txt); } catch (e) { d = null; }
            const arr = Array.isArray(d) ? d : (d && (d.data || d.templates || d.results)) || [];
            const templates = arr.map((t) => ({
              key: t.template_key || t.key || t.id || "",
              name: t.template_name || t.name || t.title || t.display_line1 || String(t.template_key || t.id || ""),
            })).filter((t) => t.key);
            return res.status(200).json({ ok: true, endpoint: u, count: templates.length, templates, raw: req.query.probe ? d : undefined });
          }
        } catch (e) { tried.push({ url: u, error: String(e) }); }
      }
      return res.status(200).json({ ok: false, templates: [], tried: req.query.probe ? tried : undefined });
    }

    // Project detail (JSON) + media images (binary) — proxied through the service-app
    // (which holds working creds) so the browser can call them same-origin.
    if (req.method === "GET" && (req.query.path === "project" || req.query.path === "image")) {
      const pid = String(req.query.id || "").replace(/[^0-9]/g, "");
      if (!pid) return res.status(400).json({ ok: false, error: "id required" });
      const r = await fetch(PROXY + "?path=" + req.query.path + "&id=" + pid, { headers: { Accept: "*/*" } });
      if (req.query.path === "image") {
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
        res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
        return res.status(r.status).send(buf);
      }
      const j = await r.json();
      return res.status(200).json(j);
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      if (!body.template_key) return res.status(200).json({ ok: false, error: "template_key required" });
      const basic = buildBasic();
      if (!basic) return res.status(200).json({ ok: false, needsAuth: true, error: "Add SITECAPTURE_USER + SITECAPTURE_PASS in Vercel to create projects." });
      // Forward the DL identity so the new project is named/located for the job it's
      // assigned to (not a blank "Project #"). SiteCapture ignores unknown fields.
      const payload = { template_key: body.template_key };
      ["client_id", "name", "external_id", "address", "latitude", "longitude", "market", "company"].forEach((k) => { if (body[k] != null && body[k] !== "") payload[k] = body[k]; });
      if (body.fields && typeof body.fields === "object") payload.fields = body.fields;
      const r = await fetch("https://api.sitecapture.com/customer_api/1_0/project", {
        method: "POST", headers: { Authorization: basic, "API_KEY": FIXED, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt }; }
      if (r.status === 401) return res.status(200).json({ ok: false, needsAuth: true, status: 401, error: "SiteCapture rejected the login (401). Set a valid SITECAPTURE_USER + SITECAPTURE_PASS in Vercel." });
      if (!r.ok) return res.status(200).json({ ok: false, status: r.status, error: (d.errors ? d.errors.join("; ") : txt.slice(0, 200)) });
      const newId = String(d.id || d.project_id || (d.project && d.project.id) || "");
      // After create, set the name/address fields on the project so it's identifiable by DL.
      // Try the documented field-update call; non-fatal if the API shape differs.
      let updated = null;
      if (newId && body.fields && typeof body.fields === "object") {
        try {
          const ur = await fetch("https://api.sitecapture.com/customer_api/1_0/project/" + newId, {
            method: "POST", headers: { Authorization: basic, "API_KEY": FIXED, "Content-Type": "application/json" },
            body: JSON.stringify({ fields: body.fields }),
          });
          updated = { status: ur.status, ok: ur.ok };
        } catch (e) { updated = { error: String(e) }; }
      }
      return res.status(200).json({ ok: true, id: newId, project: d, updated, sentPayload: req.query.debug ? payload : undefined });
    }

    const q = (req.query.q || "").toString().slice(0, 80);
    const basic = buildBasic();

    // READS via the WindMar service-app proxy (holds the working login + supports search
    // via `q`). CREATE needs this project's OWN login — validated by a tiny direct read.
    // Both run in PARALLEL so the response returns in one round-trip, not two.
    const proxyU = PROXY + "?path=projects&offset=0" + (q ? ("&q=" + encodeURIComponent(q)) : "");
    const [pRes, cRes] = await Promise.all([
      fetch(proxyU, { headers: { Accept: "application/json" } }).catch(() => null),
      basic ? fetch("https://api.sitecapture.com/customer_api/2_0/projects?max=1", { headers: { Authorization: basic, "API_KEY": FIXED, Accept: "application/json" } }).catch(() => null) : Promise.resolve(null),
    ]);
    let projects = [], ok = false;
    if (pRes && pRes.ok) {
      try {
        const body = await pRes.json();
        const arr = Array.isArray(body) ? body : (body.data || body.projects || body.results || []);
        projects = mapList(arr);
        ok = true;
      } catch (e) { /* leave ok=false */ }
    }
    const canCreate = !!(cRes && cRes.ok);

    return res.status(200).json({ configured: true, ok, source: "proxy", searchOk: ok, canCreate, count: projects.length, projects, templates: templatesOf(projects), note: canCreate ? "" : "Create a project needs valid SITECAPTURE_USER + SITECAPTURE_PASS on this Vercel project." });
  } catch (e) {
    return res.status(200).json({ configured: true, ok: false, error: String(e), projects: [] });
  }
}
