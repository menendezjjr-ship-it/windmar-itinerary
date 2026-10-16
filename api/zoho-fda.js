// /api/zoho-fda.js — look up the Approved FDA (Final Design Approval) PDF for a DL.
//
//   GET /api/zoho-fda?dl=DL9011
//
// The FDA is NOT on the Installation record — it lives on the Engineering record (Zoho module
// System_Info_Engineering, file-upload field Approved_FDA) linked to the same Deal. Lazy per-open
// lookup (one search when a job detail opens). The returned {recordId, attachmentId} stream through
// the existing /api/zoho-file (module=System_Info_Engineering is already in its allow-list).
import { zohoFetch } from "./_zoho.js";

const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";
const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, "");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "private, max-age=300");
  const dl = String(req.query.dl || "").trim();
  if (!dl) return res.status(200).json({ ok: false, found: false, error: "dl required" });
  try {
    const fields = encodeURIComponent("Name,Deal,Approved_FDA");
    const url = `${API_DOMAIN}/crm/${API_VERSION}/System_Info_Engineering/search?word=${encodeURIComponent(dl)}&fields=${fields}&per_page=20`;
    const r = await zohoFetch(url);
    if (r.status === 204) return res.status(200).json({ ok: true, found: false });
    if (!r.ok) return res.status(200).json({ ok: false, found: false, error: `Zoho ${r.status}` });
    const data = await r.json();
    const rows = data.data || [];
    const key = norm(dl);
    const hasFda = (x) => Array.isArray(x.Approved_FDA) && x.Approved_FDA.length;
    // Prefer the Engineering record whose Deal begins with this EXACT DL and that has an Approved_FDA.
    const exact = rows.filter((x) => norm(x.Deal && x.Deal.name).indexOf(key) === 0 && hasFda(x));
    const pool = exact.length ? exact : rows.filter(hasFda);
    if (!pool.length) return res.status(200).json({ ok: true, found: false });
    pool.sort((a, b) => String(b.id).localeCompare(String(a.id))); // newest Engineering record first
    const rec = pool[0];
    const f = rec.Approved_FDA
      .slice()
      .sort((a, b) => String(b.Modified_Time__s || b.Created_Time__s || "").localeCompare(String(a.Modified_Time__s || a.Created_Time__s || "")))[0];
    return res.status(200).json({
      ok: true, found: true, module: "System_Info_Engineering",
      recordId: String(rec.id), attachmentId: String(f.id),
      name: f.File_Name__s || "FDA.pdf", size: f.Size__s || 0, engName: rec.Name || "",
    });
  } catch (e) {
    return res.status(200).json({ ok: false, found: false, error: String((e && e.message) || e) });
  }
}
