// /api/geocode.js — geocode a free-form FL address to lat/lon.
// Primary: US Census geocoder (free, no key, strong US residential coverage ~93%).
// Fallback: OpenStreetMap Nominatim (+ house-number-drop + ZIP). FL-bounds validated.
const inFL = (la, lo) => la >= 24.3 && la <= 31.1 && lo >= -87.7 && lo <= -79.8;
const clean = (a) => String(a || "").replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
const withFL = (s) => (/\bfl\b|florida/i.test(s) ? s : s + ", FL");

async function census(addr) {
  try {
    const u = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(addr);
    const j = await (await fetch(u, { headers: { Accept: "application/json" } })).json();
    const m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
    if (m && isFinite(m.coordinates.y) && isFinite(m.coordinates.x) && inFL(m.coordinates.y, m.coordinates.x)) {
      return { ok: true, lat: m.coordinates.y, lon: m.coordinates.x, label: m.matchedAddress || addr, src: "census" };
    }
  } catch (e) {}
  return null;
}
async function nominatim(q) {
  const zip = (q.match(/\b(3[0-4]\d{3})\b/) || [])[1];
  const tries = [withFL(clean(q))];
  const noNum = clean(q).replace(/^\s*\d+\s+/, "").trim(); if (noNum) tries.push(withFL(noNum));
  if (zip) tries.push(zip + ", FL");
  for (const query of tries) {
    try {
      const u = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=" + encodeURIComponent(query);
      const j = await (await fetch(u, { headers: { "User-Agent": "WindMar-Itinerary/1.0 (ops@windmarhome.com)", Accept: "application/json" } })).json();
      if (Array.isArray(j) && j[0]) { const la = +j[0].lat, lo = +j[0].lon; if (isFinite(la) && isFinite(lo) && inFL(la, lo)) return { ok: true, lat: la, lon: lo, label: j[0].display_name || query, src: "osm" }; }
    } catch (e) {}
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=2592000, stale-while-revalidate=2592000"); // geocodes are stable → cache 30d
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ ok: false, error: "q required" });
  const noFb = /^(1|true|yes)$/i.test(String(req.query.nofallback || "")); // bulk callers skip OSM to respect Nominatim rate limits
  const hit = (await census(withFL(clean(q)))) || (noFb ? null : await nominatim(q));
  return res.status(200).json(hit || { ok: false, error: "no match" });
}
