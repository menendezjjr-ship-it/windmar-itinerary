// /api/push-cron.js — Vercel Cron (every minute).
// Sends a high-priority Web Push for every NEW crew status update in Supabase,
// so the coordinator is alerted even when the dashboard tab is closed.
import webpush from "web-push";

const SB_URL = "https://lmlixmzmzpzgeggvywwb.supabase.co";
const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_M634pSpAHE32sXgQlkYoGQ_prr2qjov";
const PUB = process.env.VAPID_PUBLIC_KEY || "BO0cGVF5nq1ul-JqQgDOCiHi5vJgQPnSLM4Jdl-32Y8hOv6AjAAm8UI3tZjyVXZKD0KWD801im_MBk9deCBoFCo";
const PRIV = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:ops@windmarhome.com";

const H = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };
const sb = (path, init) => fetch(SB_URL + "/rest/v1/" + path, { ...(init || {}), headers: { ...H, ...((init || {}).headers || {}) } });

export default async function handler(req, res) {
  if (!PRIV) return res.status(200).json({ ok: false, error: "VAPID_PRIVATE_KEY not set on Vercel — push disabled" });
  try {
    webpush.setVapidDetails(SUBJECT, PUB, PRIV);

    // 1) cursor (last event we already pushed)
    const curR = await sb("push_cursor?id=eq.1&select=last_created_at");
    const curJ = await curR.json();
    const since = (curJ && curJ[0] && curJ[0].last_created_at) || new Date(0).toISOString();

    // 2) new crew updates since the cursor
    const evR = await sb("job_status_events?created_at=gt." + encodeURIComponent(since) + "&order=created_at.asc&select=*&limit=25");
    const events = await evR.json();
    if (!Array.isArray(events) || !events.length) return res.status(200).json({ ok: true, sent: 0, since });

    // 3) all push subscriptions
    const subR = await sb("push_subscriptions?select=*");
    const subs = await subR.json();

    let sent = 0, pruned = 0;
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

    // 4) advance cursor to the newest event we processed
    const newest = events[events.length - 1].created_at;
    await sb("push_cursor?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_created_at: newest }) });

    return res.status(200).json({ ok: true, events: events.length, subscriptions: (subs || []).length, sent, pruned, advancedTo: newest });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
