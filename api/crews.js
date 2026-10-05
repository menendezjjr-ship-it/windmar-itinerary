// /api/crews.js — Vercel serverless proxy for Samsara fleet GPS.
// The SAMSARA_API_TOKEN secret lives ONLY in Vercel env vars — never shipped to the browser.
// Token scope required: "Read Vehicle Statistics".

// Central crew filter — WindMar installation team ONLY. Every consumer (dispatch view + Crews tab)
// sees only these trucks. Keeps INSTALACION / IN HOUSE / SERVICE + CAMION DE PRUEBA (test truck);
// drops DISPONIBLE, ALMACEN, VENTAS, CANVASSING, SITE SURVEY, ROOFING subs, Marketing/Tesla vans,
// and code-only names (e.g. GNUE-SW9-U8V).
// Edit this one regex to add crews (e.g. add ROOFING): /\b(INSTALACION|IN\s*HOUSE|SERVICE|ROOFING)\b/i
const CREW_RX = /\b(INSTALACION|IN\s*HOUSE|SERVICE)\b/i; // CAMION DE PRUEBA removed — it is the test truck, not a crew. William Sierra's truck is now correctly labeled "IN HOUSE 3 (WILLIAM SIERRA)" in Samsara, so no remap is needed.
// Trucks that MATCH the crew filter above but should NOT appear as a dispatch crew. Add a name here to
// hide a vehicle (e.g. the owner's truck). Edit this one list — no other code change needed.
const EXCLUDE_RX = /JOSE\s+MENENDEZ/i; // owner's truck — not a dispatch crew

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
    const crews = (body.data || []).filter((v) => CREW_RX.test(v.name || "") && !EXCLUDE_RX.test(v.name || "")).map((v) => {
      // Trust the Samsara vehicle label as the single source of truth for who is on each crew. The
      // old CAMION-DE-PRUEBA → William Sierra remap is obsolete (his truck is relabeled correctly now)
      // and was mislabeling his real truck as "PREVIOUS TRUCK". To fix a driver/crew name, update it
      // in Samsara — no code change needed.
      const rawName = v.name || ("Vehicle " + v.id);
      const name = rawName;
      const g = v.gps || {};
      const lat = g.latitude, lon = g.longitude;
      return {
        id: String(v.id),
        name,
        rawName, // the untouched Samsara label, so the reassignment stays auditable
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
