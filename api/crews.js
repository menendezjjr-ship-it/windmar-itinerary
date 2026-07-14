// /api/crews.js — Vercel serverless proxy for Samsara fleet GPS.
// The SAMSARA_API_TOKEN secret lives ONLY in Vercel env vars — never shipped to the browser.
// Token scope required: "Read Vehicle Statistics".

// Central crew filter — WindMar installation team ONLY. Every consumer (dispatch view + Crews tab)
// sees only these trucks. Keeps INSTALACION / IN HOUSE / SERVICE; drops DISPONIBLE, ALMACEN, VENTAS,
// CANVASSING, SITE SURVEY, ROOFING subs, Marketing/Tesla vans, and code-only names (e.g. GNUE-SW9-U8V).
// Edit this one regex to add crews (e.g. add ROOFING): /\b(INSTALACION|IN\s*HOUSE|SERVICE|ROOFING)\b/i
const CREW_RX = /\b(INSTALACION|IN\s*HOUSE|SERVICE)\b/i;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
  const token = process.env.SAMSARA_API_TOKEN || process.env.Samsara_Coordinator_Key;
  if (!token) {
    return res.status(200).json({ configured: false, ok: false, crews: [] });
  }
  try {
    const r = await fetch("https://api.samsara.com/fleet/vehicles/stats?types=gps", {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(200).json({ configured: true, ok: false, status: r.status, error: txt.slice(0, 300), crews: [] });
    }
    const body = await r.json();
    const crews = (body.data || []).filter((v) => CREW_RX.test(v.name || "")).map((v) => {
      const g = v.gps || {};
      const lat = g.latitude, lon = g.longitude;
      return {
        id: String(v.id),
        name: v.name || ("Vehicle " + v.id),
        gps: (lat != null && lon != null) ? { lat, lon } : null,
        mph: g.speedMilesPerHour != null ? Math.round(g.speedMilesPerHour) : 0,
        heading: g.headingDegrees != null ? g.headingDegrees : null,
        addr: (g.reverseGeo && g.reverseGeo.formattedLocation) || "",
        time: g.time || null,
      };
    }).filter((c) => c.gps);
    return res.status(200).json({ configured: true, ok: true, count: crews.length, crews });
  } catch (e) {
    return res.status(200).json({ configured: true, ok: false, error: String(e), crews: [] });
  }
}
