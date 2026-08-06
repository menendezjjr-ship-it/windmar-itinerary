// /api/tts.js — WinMI's NEURAL voice (smooth male). Turns text → MP3 via a cloud TTS so WinMI
// sounds the same on every device (not the robotic on-device Web Speech). Degrades gracefully:
// if no key is set, returns {configured:false} and the widget falls back to the device voice.
//
// Env (in Vercel):
//   WINMI_TTS_KEY  (or OPENAI_API_KEY)  — OpenAI key. Uses the audio/speech API.
//   WINMI_TTS_VOICE  (optional, default "onyx" — deep smooth male; also: echo, ash, ballad, verse)
//   WINMI_TTS_MODEL  (optional, default "gpt-4o-mini-tts"; fallback "tts-1")
// CORS "*" so the shared apps (Service App / Plan Analyzer) can use it via winmi.js.

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = (process.env.WINMI_TTS_KEY || process.env.OPENAI_API_KEY || "").trim();
  const voice = (process.env.WINMI_TTS_VOICE || "onyx").trim();
  const model = (process.env.WINMI_TTS_MODEL || "gpt-4o-mini-tts").trim();

  if (req.method === "GET") return res.status(200).json({ ok: true, service: "tts", configured: !!key, provider: key ? "openai" : null, voice, model });
  if (req.method !== "POST") return res.status(200).json({ ok: false, error: "POST only" });
  if (!key) return res.status(200).json({ ok: false, configured: false, error: "no TTS key set" });

  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 900);
    if (!text) return res.status(200).json({ ok: false, error: "no text" });
    const speed = Math.min(1.4, Math.max(0.8, Number(body.speed) || 1.06));

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, voice, input: text, response_format: "mp3", speed }),
    });
    if (!r.ok) {
      // Retry once on the stable model if the newer one isn't available on this key.
      if (model !== "tts-1") {
        const r2 = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "tts-1", voice, input: text, response_format: "mp3", speed }),
        });
        if (r2.ok) { const buf2 = Buffer.from(await r2.arrayBuffer()); res.setHeader("Content-Type", "audio/mpeg"); res.setHeader("Cache-Control", "no-store"); return res.status(200).send(buf2); }
      }
      const t = await r.text();
      return res.status(200).json({ ok: false, error: "tts " + r.status + ": " + t.slice(0, 180) });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
