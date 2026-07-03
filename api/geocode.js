// /api/geocode.js — geocode a free-form address to lat/lon (for Emergency Dispatch
// Routing). Uses OpenStreetMap Nominatim server-side (proper User-Agent) and biases
// to Florida. Cached a day. Falls back to a looser query if the exact address misses.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ ok: false, error: "q required" });
  const withFL = (s) => (/\bfl\b|florida/i.test(s) ? s : s + ", Florida");
  // Try the full address first, then a looser version (drop the leading house number).
  const tries = [withFL(q)];
  const noNum = q.replace(/^\s*\d+\s+/, "").trim();
  if (noNum && noNum !== q) tries.push(withFL(noNum));
  try {
    for (const query of tries) {
      const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&addressdetails=0&q=" + encodeURIComponent(query);
      const r = await fetch(url, { headers: { "User-Agent": "WindMar-Itinerary/1.0 (ops@windmarhome.com)", "Accept": "application/json", "Accept-Language": "en" } });
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j) && j[0] && isFinite(+j[0].lat) && isFinite(+j[0].lon)) {
        return res.status(200).json({ ok: true, lat: +j[0].lat, lon: +j[0].lon, label: j[0].display_name || q });
      }
    }
    return res.status(200).json({ ok: false, error: "no match" });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
