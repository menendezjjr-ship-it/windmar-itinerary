// /api/log-login.js — record a sign-in WITH approximate location, no browser prompt.
// Location comes from the connection's IP (Vercel edge geo headers), so it's captured
// automatically for every sign-in. City-level accuracy; can be off behind VPN / carrier IPs.
const SB = "https://lmlixmzmzpzgeggvywwb.supabase.co";
const K = "sb_publishable_M634pSpAHE32sXgQlkYoGQ_prr2qjov";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { email, name, app } = body || {};
  if (!email) return res.status(200).json({ ok: false, reason: "no-email" });

  const h = req.headers || {};
  const dec = (v) => { try { return v ? decodeURIComponent(v) : ""; } catch { return v || ""; } };
  const city = dec(h["x-vercel-ip-city"]);
  const region = h["x-vercel-ip-country-region"] || "";
  const country = h["x-vercel-ip-country"] || "";
  const lat = h["x-vercel-ip-latitude"] ? Number(h["x-vercel-ip-latitude"]) : null;
  const lon = h["x-vercel-ip-longitude"] ? Number(h["x-vercel-ip-longitude"]) : null;
  const cityStr = [city, region || country].filter(Boolean).join(", ") || null;

  try {
    await fetch(SB + "/rest/v1/login_events", {
      method: "POST",
      headers: { apikey: K, Authorization: "Bearer " + K, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ email: String(email).toLowerCase(), name: name || null, app: app || null, lat, lon, city: cityStr }),
    });
  } catch (e) { /* best-effort */ }

  return res.status(200).json({ ok: true, city: cityStr, lat, lon });
}
