// /api/sitecapture.js — Vercel serverless proxy for SiteCapture (auto-authenticated server-side).
// Auth = Basic base64(username:password) + fixed API_KEY. Secrets live ONLY in Vercel env vars.
// Set EITHER  SITECAPTURE_USER + SITECAPTURE_PASS  OR  Site_Capture_Key = base64("user:pass").
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
  const API_KEY = "zapier-api-4320";
  let basic = null;
  if (process.env.SITECAPTURE_USER && process.env.SITECAPTURE_PASS) {
    basic = "Basic " + Buffer.from(process.env.SITECAPTURE_USER + ":" + process.env.SITECAPTURE_PASS).toString("base64");
  } else if (process.env.Site_Capture_Key) {
    const k = process.env.Site_Capture_Key.trim();
    basic = k.toLowerCase().startsWith("basic ") ? k : ("Basic " + k);
  }
  if (!basic) return res.status(200).json({ configured: false, ok: false, projects: [] });
  const H = { Authorization: basic, "API_KEY": API_KEY, "Content-Type": "application/json" };
  try {
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      if (!body.template_key) return res.status(200).json({ ok: false, error: "template_key required" });
      const r = await fetch("https://api.sitecapture.com/customer_api/1_0/project", {
        method: "POST", headers: H, body: JSON.stringify({ template_key: body.template_key }),
      });
      const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch (e) { data = { raw: txt }; }
      if (!r.ok) return res.status(200).json({ ok: false, status: r.status, error: (data.errors ? data.errors.join("; ") : txt.slice(0, 200)) });
      return res.status(200).json({ ok: true, id: String(data.id || data.project_id || (data.project && data.project.id) || ""), project: data });
    }
    const q = (req.query.q || "").toString().slice(0, 80);
    const url = "https://api.sitecapture.com/customer_api/2_0/projects?max=24" + (q ? ("&search=" + encodeURIComponent(q)) : "");
    const r = await fetch(url, { headers: H });
    if (!r.ok) { const t = await r.text(); return res.status(200).json({ configured: true, ok: false, status: r.status, error: t.slice(0, 200), projects: [] }); }
    const body = await r.json();
    const arr = Array.isArray(body) ? body : (body.projects || body.data || []);
    const projects = arr.map((p) => ({
      id: String(p.id || p.project_id || p.key || ""),
      name: p.name || p.project_name || p.template_name || ("Project " + (p.id || "")),
      status: (p.status || "").toString(),
      address: p.address || p.location || "",
      owner: p.assigned_user || p.owner || p.created_by || p.client_name || "",
      template: p.template_name || p.template || "",
      template_key: p.template_key || "",
      updated: p.last_updated || p.date_updated || p.updated || p.last_updated_date || "",
    }));
    const tmap = {}; projects.forEach((p) => { if (p.template_key) tmap[p.template_key] = p.template || p.template_key; });
    const templates = Object.keys(tmap).map((key) => ({ key, name: tmap[key] }));
    return res.status(200).json({ configured: true, ok: true, count: projects.length, projects, templates });
  } catch (e) {
    return res.status(200).json({ configured: true, ok: false, error: String(e), projects: [] });
  }
}
