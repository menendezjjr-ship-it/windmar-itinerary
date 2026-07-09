// /api/sitecapture.js
// BROWSE: falls back to the WindMar Service app proxy (no creds, but no search).
// SEARCH + CREATE: use the direct SiteCapture API — requires a valid SiteCapture
//   login. Set SITECAPTURE_USER + SITECAPTURE_PASS (your SiteCapture login) in
//   Vercel, OR Site_Capture_Key = base64("user:pass").
const PROXY = process.env.SITECAPTURE_PROXY || "https://windmar-service-app.vercel.app/api/sitecapture";
const FIXED = process.env.SITECAPTURE_API_KEY || "zapier-api-4320";
function b64(s) { return Buffer.from(s).toString("base64"); }
// fetch with a hard timeout so a slow SiteCapture/proxy call fails fast (and we can fall back) instead of hanging.
async function fetchT(u, opts, ms) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 8000); try { return await fetch(u, Object.assign({}, opts, { signal: c.signal })); } catch (e) { return null; } finally { clearTimeout(t); } }
export const config = { maxDuration: 20 }; // headroom so a slow upstream can't 504 the whole call

// Build the Basic-auth header from whichever credential env is set.
function buildBasic() {
  if (process.env.SITECAPTURE_USER && process.env.SITECAPTURE_PASS) return "Basic " + b64(process.env.SITECAPTURE_USER + ":" + process.env.SITECAPTURE_PASS);
  if (process.env.Site_Capture_Key) { const k = process.env.Site_Capture_Key.trim(); return k.toLowerCase().startsWith("basic ") ? k : (k.indexOf(":") >= 0 ? "Basic " + b64(k) : "Basic " + k); }
  return null;
}
// SiteCapture's display_line2..5 order varies by template (some put the address on line2,
// others put a visit-type label there and the address on line3). Detect each field by shape
// instead of by fixed position so Address/Owner labels are always right.
const _isDate = (s) => /^\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/.test(String(s || ""));
const _isAddr = (s) => { s = String(s || ""); return /\d/.test(s) && (/,/.test(s) || /\b[A-Z]{2}\b/.test(s) || /\b(st|ave|rd|dr|ln|blvd|ct|way|cir|pl|ter|trl|hwy|road|street|avenue|drive|lane|court|circle|place|terrace|trail|highway)\b/i.test(s)); };
function mapList(arr) {
  return (arr || []).slice(0, 80).map((p) => {
    const lines = [p.display_line2, p.display_line3, p.display_line4, p.display_line5].map((x) => (x == null ? "" : String(x).trim())).filter(Boolean);
    const nonDate = lines.filter((x) => !_isDate(x));
    const address = p.address || p.site_address || nonDate.find(_isAddr) || "";              // most address-like line
    let owner = p.assigned_user || p.owner || p.creator || "";                                 // prefer the structured assignee
    if (!owner) owner = nonDate.find((x) => x !== address && !/\d/.test(x)) || "";             // else a name-like line
    let updated = lines.find(_isDate) || p.last_updated || p.modified_date || ""; // prefer the clean m/d/y line
    if (/^\d{4}-\d{2}-\d{2}T/.test(updated)) updated = updated.slice(5, 10).replace("-", "/") + "/" + updated.slice(0, 4); // ISO -> mm/dd/yyyy
    return {
      id: String(p.id || p.project_id || ""),
      name: p.display_line1 || p.name || p.project_name || p.title || ("Project " + (p.id || "")),
      address,
      owner,
      status: (p.status || p.project_status || "").toString(),
      template: p.template_name || p.template || "",
      updated,
      template_key: p.template_key || "",
    };
  });
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
      // After create, set the name/location fields so the project is tied to its DL.
      // Correct endpoint: POST /customer_api/2_0/project/<id> with fields:[{key,value}].
      // Unknown field keys are safely ignored by SiteCapture (returns OK).
      let updated = null;
      if (newId && Array.isArray(body.fields) && body.fields.length) {
        try {
          const ur = await fetch("https://api.sitecapture.com/customer_api/2_0/project/" + newId, {
            method: "POST", headers: { Authorization: basic, "API_KEY": FIXED, "Content-Type": "application/json" },
            body: JSON.stringify({ fields: body.fields }),
          });
          updated = { status: ur.status, ok: ur.ok };
        } catch (e) { updated = { error: String(e) }; }
      }
      return res.status(200).json({ ok: true, id: newId, project: d, updated });
    }

    const q = (req.query.q || "").toString().slice(0, 80);
    const basic = buildBasic();

    // READS hit BOTH sources IN PARALLEL — direct SiteCapture (this project's creds) + the
    // service-app proxy — and take whichever succeeds (prefer direct, which also proves the
    // create-creds). Parallel caps latency at ~one call (8s) instead of chaining two, and two
    // independent sources make a transient upstream hiccup far less likely to fail the request.
    // Failures are NEVER edge-cached (header below), so one miss can't poison the cache for 20s.
    const directU = basic ? ("https://api.sitecapture.com/customer_api/2_0/projects?max=" + (q ? 100 : 40) + "&offset=0" + (q ? ("&search=" + encodeURIComponent(q) + "&exact_text=false") : "")) : null;
    const proxyU = PROXY + "?path=projects&offset=0" + (q ? ("&q=" + encodeURIComponent(q)) : "");
    const readArr = async (r) => { if (!r || !r.ok) return null; try { const b = await r.json(); return Array.isArray(b) ? b : (b.data || b.projects || b.results || []); } catch (e) { return null; } };
    const [dArr, pArr] = await Promise.all([
      directU ? fetchT(directU, { headers: { Authorization: basic, "API_KEY": FIXED, Accept: "application/json" } }, 8000).then(readArr) : Promise.resolve(null),
      fetchT(proxyU, { headers: { Accept: "application/json" } }, 8000).then(readArr),
    ]);
    let projects = [], ok = false, canCreate = false, via = "";
    if (dArr) { projects = mapList(dArr); ok = true; canCreate = true; via = "direct"; }
    else if (pArr) { projects = mapList(pArr); ok = true; via = "proxy"; if (basic) canCreate = true; }

    res.setHeader("Cache-Control", ok ? "s-maxage=15, stale-while-revalidate=120" : "no-store"); // never cache a failure
    return res.status(200).json({ configured: true, ok, source: via || "none", searchOk: ok, canCreate, count: projects.length, projects, templates: templatesOf(projects), note: canCreate ? "" : "Create a project needs valid SITECAPTURE_USER + SITECAPTURE_PASS on this Vercel project." });
  } catch (e) {
    return res.status(200).json({ configured: true, ok: false, error: String(e), projects: [] });
  }
}
