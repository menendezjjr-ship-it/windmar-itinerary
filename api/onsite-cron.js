// /api/onsite-cron.js — Vercel Cron (every 3 min).
// Geofences live Samsara truck GPS against TODAY's job sites (from the Zoho feed,
// geocoded) and logs "on-site" sessions to Supabase table `onsite_sessions`.
//
// Every invocation, fully guarded (a bad Samsara/geocode/Zoho response must NOT throw):
//   1) fetch today's jobs → geocode each unique address → sites[]
//   2) fetch Samsara vehicle locations (fresh only, < 12 min old)
//   3) for each vehicle, find nearest site within 250 m → ON SITE
//   4) upsert one active session per vehicle+day (open / touch / close)
//
// Session model: one active row per vehicle per day. arrived_at is frozen when the
// session opens; last_seen_at ticks while the truck stays on that site; active flips
// to false when the truck leaves the geofence or moves to a different site.

const SB_URL = "https://lmlixmzmzpzgeggvywwb.supabase.co";
const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_M634pSpAHE32sXgQlkYoGQ_prr2qjov";
const H = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };
const sb = (path, init) => fetch(SB_URL + "/rest/v1/" + path, { ...(init || {}), headers: { ...H, ...((init || {}).headers || {}) } });

const SAMSARA_URL = "https://project-g7v0r.vercel.app/api/samsara?action=locations";
const ITIN = "https://windmar-itinerary.vercel.app";
const RADIUS_M = 250;        // on-site geofence radius
const STALE_MS = 12 * 60000; // ignore GPS fixes older than 12 min

// Great-circle distance between two lat/lng points, in meters.
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000; // earth radius (m)
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// person = text inside the first parens of the Samsara name, else the whole name.
// "ROOFING (ABDULLAH ABDUL)" -> "ABDULLAH ABDUL"
function personOf(name) {
  const s = String(name || "").trim();
  const m = s.match(/\(([^)]+)\)/);
  return (m ? m[1] : s).trim();
}

// Build today's geocoded job sites. Never throws; returns [] on any failure.
async function loadSites(today) {
  const sites = [];
  try {
    const r = await fetch(`${ITIN}/api/zoho-jobs?from=${today}&to=${today}`, { cache: "no-store" });
    const j = await r.json();
    const jobs = (j && Array.isArray(j.jobs)) ? j.jobs : [];
    const seen = new Map(); // addr(lower) -> {lat,lng} | null  (in-memory geocode cache for this run)
    for (const job of jobs) {
      if (!job || job.date !== today) continue;
      const addr = String(job.address || "").trim();
      const dl = String(job.num || job.id || "").trim();
      if (!addr || !dl) continue;
      const key = addr.toLowerCase();
      let coord = seen.get(key);
      if (coord === undefined) { // not yet geocoded this run
        coord = null;
        try {
          const gr = await fetch(`${ITIN}/api/geocode?q=${encodeURIComponent(addr)}`, { cache: "no-store" });
          const gj = await gr.json();
          const la = gj && +gj.lat, lo = gj && +(gj.lng != null ? gj.lng : gj.lon);
          if (gj && gj.ok && isFinite(la) && isFinite(lo)) coord = { lat: la, lng: lo };
        } catch (_) { coord = null; }
        seen.set(key, coord);
      }
      if (coord) sites.push({ dl, addr, lat: coord.lat, lng: coord.lng });
    }
  } catch (_) { /* leave sites empty */ }
  return sites;
}

// Fetch fresh Samsara vehicle locations. Never throws; returns [] on failure.
async function loadVehicles() {
  try {
    const r = await fetch(SAMSARA_URL, { cache: "no-store" });
    const j = await r.json();
    const locs = (j && Array.isArray(j.locations)) ? j.locations : [];
    const now = Date.now();
    return locs.filter((v) => {
      if (!v) return false;
      const t = Date.parse(v.time);
      if (!isFinite(t) || now - t > STALE_MS) return false; // FRESH only
      return isFinite(+v.lat) && isFinite(+v.lng);
    });
  } catch (_) { return []; }
}

export default async function handler(req, res) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    const sites = await loadSites(today);
    const vehicles = await loadVehicles();

    let onSite = 0, updated = 0, opened = 0, closed = 0;

    for (const v of vehicles) {
      const vlat = +v.lat, vlng = +v.lng;

      // nearest site within RADIUS_M
      let best = null, bestD = Infinity;
      for (const s of sites) {
        const d = haversine(vlat, vlng, s.lat, s.lng);
        if (d < bestD) { bestD = d; best = s; }
      }
      const site = (best && bestD <= RADIUS_M) ? best : null;

      const vehName = String(v.name || "").trim();
      const encVeh = encodeURIComponent(vehName);
      const encDay = encodeURIComponent(today);

      // current active session for this vehicle today (if any)
      let activeRow = null;
      try {
        const qr = await sb(`onsite_sessions?vehicle=eq.${encVeh}&day=eq.${encDay}&active=eq.true&select=*`);
        const rows = await qr.json();
        activeRow = (Array.isArray(rows) && rows[0]) || null;
      } catch (_) { activeRow = null; }

      if (site) {
        onSite++;
        if (activeRow && activeRow.job_dl === site.dl) {
          // still on the same site → touch last_seen_at
          try {
            await sb(`onsite_sessions?id=eq.${encodeURIComponent(activeRow.id)}`, {
              method: "PATCH", headers: { Prefer: "return=minimal" },
              body: JSON.stringify({ last_seen_at: now }),
            });
            updated++;
          } catch (_) {}
        } else {
          // moved to a different site (or none open) → close the old one, open a new one
          if (activeRow) {
            try {
              await sb(`onsite_sessions?id=eq.${encodeURIComponent(activeRow.id)}`, {
                method: "PATCH", headers: { Prefer: "return=minimal" },
                body: JSON.stringify({ active: false }),
              });
              closed++;
            } catch (_) {}
          }
          try {
            await sb("onsite_sessions", {
              method: "POST", headers: { Prefer: "return=minimal" },
              body: JSON.stringify({
                day: today, vehicle: vehName, person: personOf(vehName),
                job_dl: site.dl, job_addr: site.addr, lat: vlat, lng: vlng,
                arrived_at: now, last_seen_at: now, active: true,
              }),
            });
            opened++;
          } catch (_) {}
        }
      } else if (activeRow) {
        // not on any site → close the open session (duration frozen at last_seen_at)
        try {
          await sb(`onsite_sessions?id=eq.${encodeURIComponent(activeRow.id)}`, {
            method: "PATCH", headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ active: false }),
          });
          closed++;
        } catch (_) {}
      }
    }

    return res.status(200).json({ ok: true, sites: sites.length, vehicles: vehicles.length, onSite, updated, opened, closed });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
