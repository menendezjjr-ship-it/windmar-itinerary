// api/revert-status.js — soft-delete ("revert") a mistaken crew status in the shared Supabase.
//
// Why server-side: the shared `job_status_events` table blocks BOTH UPDATE and DELETE for the
// public anon key (RLS — a client PATCH/DELETE returns success but changes 0 rows, verified).
// So the revert write must run with the Supabase SERVICE ROLE key, which bypasses RLS.
//
// SETUP: add `SUPABASE_SERVICE_ROLE_KEY` (the service_role secret from the shared Supabase project
// lmlixmzmzpzgeggvywwb → Settings → API) to the windmar-itinerary Vercel project env vars.
// Without it, this endpoint responds ok:false and the frontend restores the card + alerts.
//
// Revert = PATCH status -> "[VOID] <original>", acknowledged:true. The frontend treats any status
// starting with "[VOID]" as removed (filtered out of the feed, counts, records, notifications).

const SB_URL = process.env.SUPABASE_URL || "https://lmlixmzmzpzgeggvywwb.supabase.co";
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "").trim();
const ANON_KEY = (process.env.SUPABASE_ANON_KEY || "sb_publishable_M634pSpAHE32sXgQlkYoGQ_prr2qjov").trim();

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "POST only" }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== "object") body = {};
  const id = String(body.id || "").trim();
  const status = String(body.status || "");
  const who = String(body.who || "admin").trim() || "admin";
  const origNote = String(body.note || "").trim();
  if (!id) { res.status(400).json({ ok: false, error: "missing id" }); return; }

  const usingService = !!SERVICE_KEY;
  const key = SERVICE_KEY || ANON_KEY;
  const newStatus = "[VOID] " + status;
  // Audit stamp: who reverted, when, and what it was — written server-side into the row's note.
  const day = new Date().toISOString().slice(0, 10);
  const auditNote = "↩ reverted by " + who + " · " + day + " — was: " + (origNote || status || "(empty)");

  try {
    const r = await fetch(SB_URL + "/rest/v1/job_status_events?id=eq." + encodeURIComponent(id), {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ status: newStatus, acknowledged: true, note: auditNote }),
    });
    const txt = await r.text();
    let rows = []; try { rows = JSON.parse(txt); } catch (e) {}
    const updated = Array.isArray(rows) ? rows.length : 0;

    if (updated > 0) { res.status(200).json({ ok: true, usingService, updated }); return; }

    // 0 rows changed → blocked by RLS (no service key) or id not found.
    res.status(200).json({
      ok: false,
      usingService,
      updated: 0,
      reason: usingService
        ? "no row updated (id not found?)"
        : "anon key cannot UPDATE job_status_events (RLS blocks it); set SUPABASE_SERVICE_ROLE_KEY on Vercel",
      httpStatus: r.status,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
