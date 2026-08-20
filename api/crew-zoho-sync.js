// /api/crew-zoho-sync.js — catch-up for crew status updates that never reached Zoho.
//
// The per-minute cron (api/push-cron.js) mirrors every NEW crew update. This endpoint runs the
// SAME code over an explicit date range so updates from BEFORE that cron existed — or ones whose
// submit-time POST failed — get their note and their photos into Zoho too.
//
// GET /api/crew-zoho-sync?since=2026-08-19            → mirror everything from that date on
// GET /api/crew-zoho-sync?since=...&dryRun=1          → report what WOULD happen, write nothing
// GET /api/crew-zoho-sync?since=...&dl=DL6731         → limit to one job
// GET /api/crew-zoho-sync?since=...&notes=0           → photos only, skip the note check
//
// Safe to re-run: syncCrewToZoho() skips a photo whose attachment name is already on the record
// and skips a note whose marker (or text) is already there. It never advances the cron cursor.
import { syncCrewToZoho, normPhotos, MODULE_FOR } from "./_crew-photos.js";

const SB_URL = "https://lmlixmzmzpzgeggvywwb.supabase.co";
const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_M634pSpAHE32sXgQlkYoGQ_prr2qjov";
const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";

const hasCreds = () => !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN);
async function getAccessToken() {
  const res = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: process.env.ZOHO_CLIENT_ID, client_secret: process.env.ZOHO_CLIENT_SECRET, refresh_token: process.env.ZOHO_REFRESH_TOKEN }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(`token refresh failed: ${d.error || "unknown"}`);
  return d.access_token;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasCreds()) return res.status(200).json({ ok: false, error: "Zoho creds not set" });

  // Bounded window so a stray call can never walk the whole table.
  const since = /^\d{4}-\d{2}-\d{2}/.test(String(req.query.since || "")) ? String(req.query.since) : "";
  if (!since) return res.status(200).json({ ok: false, error: "since=YYYY-MM-DD required" });
  const dl = String(req.query.dl || "").replace(/[^A-Za-z0-9-]/g, "");
  const dryRun = !!req.query.dryRun;
  const doNotes = String(req.query.notes || "") !== "0";
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

  try {
    let q = `job_status_events?source=eq.field-hub&created_at=gte.${encodeURIComponent(since)}`
          + `&order=created_at.asc&select=*&limit=${limit}`;
    if (dl) q += `&dl_number=eq.${encodeURIComponent(dl)}`;
    const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } });
    if (!r.ok) return res.status(200).json({ ok: false, error: `supabase ${r.status}` });
    const events = await r.json();
    if (!Array.isArray(events)) return res.status(200).json({ ok: false, error: "bad supabase response" });

    if (dryRun) {
      const plan = events
        .filter((e) => MODULE_FOR[String(e.job_type || "").toLowerCase()]
                    && String(e.job_id || "").replace(/[^0-9]/g, "")
                    && (normPhotos(e.photos).length || e.note))
        .map((e) => ({ id: e.id, at: e.created_at, dl: e.dl_number, job_type: e.job_type,
                       module: MODULE_FOR[String(e.job_type).toLowerCase()], job_id: e.job_id,
                       photos: normPhotos(e.photos).length, hasNote: !!e.note }));
      return res.status(200).json({ ok: true, dryRun: true, since, scanned: events.length, wouldProcess: plan.length, plan });
    }

    const out = await syncCrewToZoho(events, await getAccessToken(), { notes: doNotes });
    return res.status(200).json({ ok: true, since, scanned: events.length, ...out });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
