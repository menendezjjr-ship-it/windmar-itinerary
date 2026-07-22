// /api/push-cron.js — Vercel Cron (every minute).
// Two independent jobs over the SAME batch of new job_status_events (one shared cursor):
//   1) Web Push  — high-priority notification for every NEW crew status update (gated on VAPID keys).
//   2) BOM sync  — mirror every NEW plan-analyzer note into its Zoho Installation record as a Note.
// The cursor read + event fetch + BOM sync run REGARDLESS of VAPID; only the push send is gated.
// The cursor advances ONCE at the end covering every processed event (prevents re-processing / dup notes).
import webpush from "web-push";

const SB_URL = "https://lmlixmzmzpzgeggvywwb.supabase.co";
const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_M634pSpAHE32sXgQlkYoGQ_prr2qjov";
// .trim() + strip any accidental padding/quotes so a stray space/newline pasted
// into the Vercel env var doesn't break web-push's strict URL-safe-base64 check.
const clean = (v) => String(v || "").trim().replace(/^["']|["']$/g, "").replace(/=+$/, "");
const PUB = clean(process.env.VAPID_PUBLIC_KEY) || "BO0cGVF5nq1ul-JqQgDOCiHi5vJgQPnSLM4Jdl-32Y8hOv6AjAAm8UI3tZjyVXZKD0KWD801im_MBk9deCBoFCo";
const PRIV = clean(process.env.VAPID_PRIVATE_KEY);
const SUBJECT = String(process.env.VAPID_SUBJECT || "mailto:ops@windmarhome.com").trim();

const H = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };
const sb = (path, init) => fetch(SB_URL + "/rest/v1/" + path, { ...(init || {}), headers: { ...H, ...((init || {}).headers || {}) } });

// ── Zoho (replicated from zoho-add-note.js so this lambda is self-contained) ──
const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || "https://accounts.zoho.com";
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";
const zohoHasCreds = () => !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN);
let cachedToken = null, tokenExpiry = 0;
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: process.env.ZOHO_CLIENT_ID, client_secret: process.env.ZOHO_CLIENT_SECRET, refresh_token: process.env.ZOHO_REFRESH_TOKEN }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`token refresh failed: ${data.error || JSON.stringify(data)}`);
  cachedToken = data.access_token; tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}
async function addNote(token, module, recordId, title, content) {
  const url = `${API_DOMAIN}/crm/${API_VERSION}/${encodeURIComponent(module)}/${encodeURIComponent(recordId)}/Notes`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: [{ Note_Title: (title || "BOM Note").slice(0, 120), Note_Content: content || "" }] }),
  });
  const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt }; }
  const rec = d && d.data && d.data[0];
  return { ok: !!(rec && rec.code === "SUCCESS"), body: d };
}

// Build { DL(UPPER): recordId } from the app's own live feed (one fetch per cron run).
async function buildDlMap() {
  const iso = (d) => d.toISOString().slice(0, 10);
  const shift = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
  const url = `https://windmar-itinerary.vercel.app/api/zoho-jobs?from=${shift(-30)}&to=${shift(60)}&only=install`;
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json();
  const map = {};
  for (const job of (j && Array.isArray(j.jobs) ? j.jobs : [])) {
    if (job.kind === "install" && job.recordId) {
      const dl = String(job.num || job.id || "").trim().toUpperCase();
      if (dl && !map[dl]) map[dl] = job.recordId;
    }
  }
  return map;
}

// Mirror new plan-analyzer notes → Zoho Installation Notes. Fully guarded: never throws to the caller.
async function syncBomNotes(events) {
  const out = { bomSynced: 0, bomSkipped: 0, bomErrors: 0 };
  try {
    const candidates = (events || []).filter((ev) => ev && ev.source === "plan-analyzer" && String(ev.note || "").trim());
    if (!candidates.length) return out;
    if (!zohoHasCreds()) { out.bomSkipped += candidates.length; out.bomNote = "zoho creds not set"; return out; }
    const [token, dlMap] = await Promise.all([getAccessToken(), buildDlMap()]);
    for (const ev of candidates) {
      const dl = String(ev.dl_number || "").trim().toUpperCase();
      const recordId = dl && dlMap[dl];
      if (!recordId) { out.bomSkipped++; continue; } // DL outside the feed window → skip (don't fail the run)
      const title = "BOM · " + (ev.status || "Update");
      const content = String(ev.note).trim() + " (Plan Analyzer" + (ev.created_by ? " · " + ev.created_by : "") + ")";
      try {
        const r = await addNote(token, "Installation", recordId, title, content);
        if (r.ok) out.bomSynced++; else out.bomErrors++;
      } catch (e) { out.bomErrors++; }
    }
  } catch (e) { out.bomError = String(e && e.message || e); }
  return out;
}

// Fire any due lunch alarms (independent of the crew-update/BOM batch; runs every invocation).
// Contract: table `lunch_alarms` (email,name,endpoint,p256dh,auth,fire_at,sent). A row with
// sent=false and fire_at<=now means "ring this subscription now". Marks each row sent even on
// failure (incl. 404/410 gone) so a bad subscription can't cause infinite retries.
async function fireLunchAlarms() {
  const out = { lunchFired: 0, lunchErrors: 0, lunchDue: 0 };
  try {
    if (!PRIV) return out; // gated on VAPID exactly like the crew-update push
    webpush.setVapidDetails(SUBJECT, PUB, PRIV);
    const nowIso = new Date().toISOString();
    const dueR = await sb("lunch_alarms?sent=eq.false&fire_at=lte." + encodeURIComponent(nowIso) + "&select=*");
    const rows = await dueR.json();
    if (!Array.isArray(rows) || !rows.length) return out;
    out.lunchDue = rows.length;
    const payload = JSON.stringify({ title: "🍽 Lunch's over", body: "Time to get back to work.", tag: "wm-lunch" });
    for (const row of rows) {
      const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      try {
        await webpush.sendNotification(subscription, payload, { urgency: "high", TTL: 3600 });
        out.lunchFired++;
      } catch (e) { out.lunchErrors++; }
      // Mark done regardless of send outcome (prevents infinite retries on gone/expired subs).
      try {
        const sel = row.id != null
          ? "lunch_alarms?id=eq." + encodeURIComponent(row.id)
          : "lunch_alarms?endpoint=eq." + encodeURIComponent(row.endpoint) + "&sent=eq.false";
        await sb(sel, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ sent: true }) });
      } catch (_) {}
    }
  } catch (e) { out.lunchError = String(e && e.message || e); }
  return out;
}

export default async function handler(req, res) {
  try {
    // 0) lunch alarms — independent job, runs every invocation (before the no-events early return)
    const lunch = await fireLunchAlarms();

    // 1) cursor (last event we already processed)
    const curR = await sb("push_cursor?id=eq.1&select=last_created_at");
    const curJ = await curR.json();
    const since = (curJ && curJ[0] && curJ[0].last_created_at) || new Date(0).toISOString();

    // 2) new events since the cursor (shared by push + BOM sync)
    const evR = await sb("job_status_events?created_at=gt." + encodeURIComponent(since) + "&order=created_at.asc&select=*&limit=25");
    const events = await evR.json();
    if (!Array.isArray(events) || !events.length) return res.status(200).json({ ok: true, sent: 0, bomSynced: 0, since, ...lunch });

    // 3) BOM sync (runs regardless of VAPID; never breaks push or the cursor advance)
    const bom = await syncBomNotes(events);

    // 4) Web Push — only if VAPID is configured
    let sent = 0, pruned = 0, pushEnabled = false, subsCount = 0;
    if (PRIV) {
      try {
        pushEnabled = true;
        webpush.setVapidDetails(SUBJECT, PUB, PRIV);
        const subR = await sb("push_subscriptions?select=*");
        const subs = await subR.json();
        subsCount = (Array.isArray(subs) ? subs : []).length;
        for (const ev of events) {
          const who = [ev.dl_number, ev.customer].filter(Boolean).join(" ") || ev.job_id || "Job";
          const payload = JSON.stringify({
            title: "🔔 " + (ev.status || "Crew Update") + " — needs stage change",
            body: who + (ev.team ? " · " + ev.team : "") + (ev.note ? "\n📝 " + ev.note : ""),
            tag: "crew-" + ev.id,
            url: "https://windmar-itinerary.vercel.app/",
          });
          for (const s of (Array.isArray(subs) ? subs : [])) {
            const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
            try {
              await webpush.sendNotification(subscription, payload, { urgency: "high", TTL: 3600 });
              sent++;
            } catch (e) {
              // 404/410 = subscription expired → remove it
              if (e && (e.statusCode === 404 || e.statusCode === 410)) {
                try { await sb("push_subscriptions?endpoint=eq." + encodeURIComponent(s.endpoint), { method: "DELETE" }); pruned++; } catch (_) {}
              }
            }
          }
        }
      } catch (e) { /* push failure must not block the cursor advance */ }
    }

    // 5) advance cursor ONCE to the newest event we processed (push + sync share this batch)
    const newest = events[events.length - 1].created_at;
    await sb("push_cursor?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_created_at: newest }) });

    return res.status(200).json({ ok: true, events: events.length, pushEnabled, subscriptions: subsCount, sent, pruned, advancedTo: newest, ...bom, ...lunch });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
