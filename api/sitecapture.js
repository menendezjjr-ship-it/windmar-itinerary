// /api/sitecapture.js
// READS (search/list): reuse the WindMar Service app's authenticated proxy — no creds needed here.
// WRITES (create project): require SiteCapture write credentials, because creating in your account
//   always needs authentication. Set SITECAPTURE_USER + SITECAPTURE_PASS (your SiteCapture login)
//   in Vercel, OR Site_Capture_Key = base64("user:pass").
const PROXY = process.env.SITECAPTURE_PROXY || "https://windmar-service-app.vercel.app/api/sitecapture";
function b64(s){ return Buffer.from(s).toString("base64"); }
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=60");
  try {
    // Diagnostic: tests the SAME credentials the create uses against a simple read,
    // so we can tell if a 401 is bad login vs. something else. Leaks no secrets.
    if (req.method === "GET" && req.query.diag) {
      let src = "none", basic = null;
      if (process.env.SITECAPTURE_USER && process.env.SITECAPTURE_PASS) {
        basic = "Basic " + b64(process.env.SITECAPTURE_USER + ":" + process.env.SITECAPTURE_PASS);
        src = "SITECAPTURE_USER/PASS";
      } else if (process.env.Site_Capture_Key) {
        const k = process.env.Site_Capture_Key.trim();
        basic = k.toLowerCase().startsWith("basic ") ? k : (k.indexOf(":") >= 0 ? "Basic " + b64(k) : "Basic " + k);
        src = "Site_Capture_Key";
      }
      if (!basic) return res.status(200).json({ diag: true, authSource: "none", note: "No SiteCapture creds set on this project" });
      const FIXED = process.env.SITECAPTURE_API_KEY || "zapier-api-4320";
      const userLen = (process.env.SITECAPTURE_USER || "").length, passLen = (process.env.SITECAPTURE_PASS || "").length;
      try {
        const r = await fetch("https://api.sitecapture.com/customer_api/2_0/projects?max=1", { headers: { Authorization: basic, "API_KEY": FIXED, Accept: "application/json" } });
        const txt = await r.text();
        return res.status(200).json({ diag: true, authSource: src, apiKeyUsed: FIXED, userLen, passLen, status: r.status, ok: r.ok, body: txt.slice(0, 180) });
      } catch (e) { return res.status(200).json({ diag: true, authSource: src, error: String(e) }); }
    }
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      if (!body.template_key) return res.status(200).json({ ok:false, error:"template_key required" });
      const FIXED = process.env.SITECAPTURE_API_KEY || "zapier-api-4320";
      let basic = null;
      if (process.env.SITECAPTURE_USER && process.env.SITECAPTURE_PASS) {
        basic = "Basic " + b64(process.env.SITECAPTURE_USER + ":" + process.env.SITECAPTURE_PASS);
      } else if (process.env.Site_Capture_Key) {
        const k = process.env.Site_Capture_Key.trim();
        basic = k.toLowerCase().startsWith("basic ") ? k : (k.indexOf(":") >= 0 ? "Basic " + b64(k) : "Basic " + k);
      }
      if (!basic) return res.status(200).json({ ok:false, needsAuth:true, error:"Add SITECAPTURE_USER + SITECAPTURE_PASS in Vercel to create projects." });
      const payload = { template_key: body.template_key };
      if (body.client_id) payload.client_id = body.client_id;
      const r = await fetch("https://api.sitecapture.com/customer_api/1_0/project", {
        method:"POST", headers:{ Authorization:basic, "API_KEY":FIXED, "Content-Type":"application/json" },
        body: JSON.stringify(payload),
      });
      const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt }; }
      if (!r.ok) return res.status(200).json({ ok:false, status:r.status, error:(d.errors ? d.errors.join("; ") : txt.slice(0,200)) });
      return res.status(200).json({ ok:true, id:String(d.id || d.project_id || (d.project && d.project.id) || ""), project:d });
    }
    const q = (req.query.q || "").toString().slice(0, 80);
    const u = PROXY + "?path=projects&offset=0" + (q ? ("&search=" + encodeURIComponent(q)) : "");
    const r = await fetch(u, { headers: { Accept: "application/json" } });
    if (!r.ok) { const t = await r.text(); return res.status(200).json({ configured:true, ok:false, status:r.status, error:t.slice(0,160), projects:[] }); }
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.data || j.projects || j.results || []);
    const projects = arr.slice(0, 60).map((p) => ({
      id:String(p.id || p.project_id || ""), name:p.display_line1 || p.name || ("Project " + (p.id || "")),
      address:p.display_line2 || p.address || "", owner:p.display_line3 || p.assigned_user || "",
      status:(p.status || "").toString(), template:p.template_name || "", updated:p.display_line4 || p.last_updated || "",
      template_key:p.template_key || "",
    }));
    const tmap = {}; projects.forEach((p) => { if (p.template_key) tmap[p.template_key] = p.template || p.template_key; });
    const templates = Object.keys(tmap).map((k) => ({ key:k, name:tmap[k] }));
    const canCreate = !!((process.env.SITECAPTURE_USER && process.env.SITECAPTURE_PASS) || process.env.Site_Capture_Key);
    return res.status(200).json({ configured:true, ok:true, canCreate, count:(arr.length), projects, templates, via:"service-app" });
  } catch (e) {
    return res.status(200).json({ configured:true, ok:false, error:String(e), projects:[] });
  }
}
