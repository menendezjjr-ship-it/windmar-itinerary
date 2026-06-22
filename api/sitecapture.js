// /api/sitecapture.js — reuses the WindMar Service app's already-authenticated SiteCapture proxy.
// No credentials needed here: the service app holds them server-side. Override with
// SITECAPTURE_PROXY env var, or set SITECAPTURE_USER/PASS to call SiteCapture directly instead.
const PROXY = process.env.SITECAPTURE_PROXY || "https://windmar-service-app.vercel.app/api/sitecapture";
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=60");
  try {
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      if (!body.template_key) return res.status(200).json({ ok: false, error: "template_key required" });
      const r = await fetch(PROXY + "?path=project", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_key: body.template_key }),
      });
      const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt }; }
      if (!r.ok) return res.status(200).json({ ok: false, status: r.status, error: txt.slice(0, 200) });
      return res.status(200).json({ ok: true, id: String(d.id || (d.data && d.data.id) || d.project_id || ""), raw: d });
    }
    const q = (req.query.q || "").toString().slice(0, 80);
    const u = PROXY + "?path=projects&offset=0" + (q ? ("&search=" + encodeURIComponent(q)) : "");
    const r = await fetch(u, { headers: { Accept: "application/json" } });
    if (!r.ok) { const t = await r.text(); return res.status(200).json({ configured: true, ok: false, status: r.status, error: t.slice(0, 160), projects: [] }); }
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.data || j.projects || j.results || []);
    const projects = arr.slice(0, 60).map((p) => ({
      id: String(p.id || p.project_id || ""),
      name: p.display_line1 || p.name || ("Project " + (p.id || "")),
      address: p.display_line2 || p.address || "",
      owner: p.display_line3 || p.assigned_user || "",
      status: (p.status || "").toString(),
      template: p.template_name || "",
      updated: p.display_line4 || p.last_updated || "",
      template_key: p.template_key || "",
    }));
    const tmap = {}; projects.forEach((p) => { if (p.template_key) tmap[p.template_key] = p.template || p.template_key; });
    const templates = Object.keys(tmap).map((k) => ({ key: k, name: tmap[k] }));
    return res.status(200).json({ configured: true, ok: true, count: (arr.length), projects, templates, via: "service-app" });
  } catch (e) {
    return res.status(200).json({ configured: true, ok: false, error: String(e), projects: [] });
  }
}
