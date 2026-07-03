// /api/geocode.js — geocode a free-form address to lat/lon (for Emergency Dispatch
// Routing). Uses OpenStreetMap Nominatim server-side (proper User-Agent) and biases
// to Florida. Cached a day. Falls back to a looser query if the exact address misses.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ ok: false, error: "q required" });
  const withFL = (s) => (/\bfl\b|florida/i.test(s) ? s : s + ", Florida");
  const inFL = (la, lo) => la >= 24.3 && la <= 31.1 && lo >= -87.7 && lo <= -79.8; // reject wrong-state matches
  // Try full address → drop the house number → the ZIP (if present). ZIP resolves the
  // right area even when a new-development street isn't in the map data yet.
  const tries = [withFL(q)];
  const noNum = q.replace(/^\s*\d+\s+/, "").trim();
  if (noNum && noNum !== q) tries.push(withFL(noNum));
  const zip = (q.match(/\b(3[0-4]\d{3})\b/) || [])[1]; // FL ZIPs 32xxx–34xxx
  if (zip) tries.push(zip + ", Florida");
  try {
    for (const query of tries) {
      const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&addressdetails=0&q=" + encodeURIComponent(query);
      const r = await fetch(url, { headers: { "User-Agent": "WindMar-Itinerary/1.0 (ops@windmarhome.com)", "Accept": "application/json", "Accept-Language": "en" } });
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j) && j[0]) {
        const la = +j[0].lat, lo = +j[0].lon;
        if (isFinite(la) && isFinite(lo) && inFL(la, lo)) return res.status(200).json({ ok: true, lat: la, lon: lo, label: j[0].display_name || query });
      }
    }
    return res.status(200).json({ ok: false, error: "no match" });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
