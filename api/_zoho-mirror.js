// Itinerary-side reader for the shared Zoho→Supabase mirror (table zoho_cache on the data-bus project
// lmlixmzmzpzgeggvywwb). The Field HUB cron (windmar-operations/api/zoho-sync.js) is the single writer;
// it stores the RAW Zoho records under module install_raw / service_raw (a literal copy of Zoho), so
// zoho-jobs.js can run its OWN mappers (mapInstall / expandServiceVisits) on them — zero live Zoho calls
// on the hot path. Reads FALL BACK to live Zoho whenever a month is missing from the mirror, so nothing
// breaks before the raws exist or for windows outside the mirrored range. Underscore-prefixed → not a route.
const SB_URL = "https://lmlixmzmzpzgeggvywwb.supabase.co";
const SB_KEY = "sb_publishable_M634pSpAHE32sXgQlkYoGQ_prr2qjov";
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

export function monthKeyOf(m, y) {
  return `${y}-${String(m).padStart(2, "0")}`;
}

// The YYYY-MM month keys a [from,to] date window touches (capped so a bad wide range can't loop).
export function monthsBetween(from, to) {
  const out = [];
  let [fy, fm] = String(from).split("-").map(Number);
  const [ty, tm] = String(to).split("-").map(Number);
  if (!fy || !ty) return out;
  while (fy < ty || (fy === ty && fm <= tm)) {
    out.push(`${fy}-${String(fm).padStart(2, "0")}`);
    fm++; if (fm > 12) { fm = 1; fy++; }
    if (out.length > 18) break;
  }
  return out;
}

// Raw records mirrored for one module+month, or null when the mirror is unavailable/empty for that
// month (the caller then falls back to live Zoho). Never throws — a mirror hiccup must not break a read.
export async function readMirror(module, monthKey) {
  try {
    const url =
      `${SB_URL}/rest/v1/zoho_cache?select=data` +
      `&module=eq.${encodeURIComponent(module)}&month_key=eq.${encodeURIComponent(monthKey)}&limit=5000`;
    const r = await fetch(url, { headers: H, cache: "no-store" });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows.map((x) => x.data).filter(Boolean);
  } catch {
    return null;
  }
}
