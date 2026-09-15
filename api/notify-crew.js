// /api/notify-crew.js — a coordinator resolved a Quick Job claim; tell the CREW MEMBER who
// claimed it, via a Power Automate flow (TEAMS_CREW_WEBHOOK_URL).
//
// POST { num, customer, address, scope, crew_name, crew_email, miles, status:'confirmed'|'no_response', coordinator?, test? }
//   -> POSTs FLAT JSON to the flow so it can DM the requester by `email`:
//      { email, crew_name, num, customer, address, scope, miles, status, coordinator, title, message }
//   The flow's "Post message" step targets `email` and posts `message` (or builds its own card from
//   these fields). Flat JSON — NOT a Teams card — because the flow, not us, decides the destination.
// GET ?diag=1 -> { configured, host } (booleans + bare domain only — never the URL; it's a credential).

const HOOK = (process.env.TEAMS_CREW_WEBHOOK_URL || "").trim();
const S = (v, n) => String(v == null ? "" : v).replace(new RegExp("[\\u0000-\\u001F\\u007F]", "g"), " ").trim().slice(0, n || 200);

function build(b) {
  const confirmed = b.status === "confirmed";
  const num = S(b.num, 40) || "Quick Job";
  const customer = S(b.customer, 120) || "the customer";
  const address = S(b.address, 200);
  const miles = b.miles != null && b.miles !== "" ? (Number(b.miles) || 0).toFixed(1) : null;
  const title = (confirmed ? "✅ Confirmed — " : "⚠️ No response — ") + num;
  const where = customer + (address ? " (" + address + ")" : "");
  const message = confirmed
    ? "✅ " + num + " confirmed — the coordinator booked it with " + where + ". Head over."
    : "⚠️ " + num + " — no response from the homeowner yet. Hold off until the coordinator confirms. " + where;
  return {
    email: S(b.crew_email, 160),
    crew_name: S(b.crew_name, 80) || "Crew",
    num, customer, address,
    scope: S(b.scope, 160),
    miles: miles ? Number(miles) : null,
    status: confirmed ? "confirmed" : "no_response",
    coordinator: S(b.coordinator, 80) || null,
    title, message,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({ configured: !!HOOK, host: HOOK ? (HOOK.split("/")[2] || "") : null });
  }
  if (req.method !== "POST") return res.status(200).json({ ok: false, error: "POST only" });
  if (!HOOK) return res.status(200).json({ ok: false, configured: false, error: "TEAMS_CREW_WEBHOOK_URL is not set on this project" });

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  if (b.status !== "confirmed" && b.status !== "no_response") {
    return res.status(200).json({ ok: false, error: "status must be 'confirmed' or 'no_response'" });
  }
  const payload = build(b);
  if (b.test) { payload.test = true; payload.title = "TEST — " + payload.title; payload.message = "TEST (no action needed) — " + payload.message; }

  try {
    const r = await fetch(HOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const txt = (await r.text().catch(() => "")).slice(0, 200);
    const ok = r.ok || r.status === 202;
    return res.status(200).json({ ok, status: r.status, sentTo: payload.email || null, response: txt });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
