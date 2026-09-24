// /api/tts.js — WinMI's NEURAL voice. Turns text → MP3 via a cloud TTS so WinMI sounds the same on
// every device (not the robotic on-device Web Speech). Degrades gracefully: if no key is set it
// returns {configured:false} and the widget falls back to the device voice.
//
// PROVIDER PRIORITY: Cartesia (Sonic — most natural) → OpenAI → device voice.
//
// Env (in Vercel → windmar-itinerary → Settings → Environment Variables):
//   CARTESIA_API_KEY   — Cartesia key (https://play.cartesia.ai → API Keys). If set, WinMI uses Cartesia.
//   CARTESIA_VOICE_ID  — the voice UUID from Cartesia → Voices (e.g. the "Daniel / Jameson" male voice
//                        you picked; copy its ID). Defaults to a Cartesia stock male voice.
//   CARTESIA_MODEL     — optional, default "sonic-2" (latest; also "sonic-turbo" faster, "sonic").
//   WINMI_TTS_KEY / OPENAI_API_KEY — OpenAI fallback key.
//   WINMI_TTS_VOICE (default "onyx"), WINMI_TTS_MODEL (default "gpt-4o-mini-tts", fallback "tts-1").
// CORS "*" so the shared apps (Service App / Plan Analyzer) can use it via winmi.js.

export const config = { maxDuration: 30 };

// ── App-key gate: el header x-app-key debe coincidir con APP_API_KEY (env).
// Si APP_API_KEY no está configurada, el gate queda abierto (deploy-safe).
const APP_API_KEY = (process.env.APP_API_KEY || "").trim();
function hasValidAppKey(req) {
  if (!APP_API_KEY) return true;
  const h = (req.headers || {});
  const got = h["x-app-key"] || h["X-App-Key"] || "";
  return got === APP_API_KEY;
}

const CARTESIA_VERSION = "2024-11-13"; // required Cartesia API version header

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const cartKey = (process.env.CARTESIA_API_KEY || "").trim();
  const cartVoice = (process.env.CARTESIA_VOICE_ID || "a0e99841-438c-4a64-b679-ae501e7d6091").trim();
  const cartModel = (process.env.CARTESIA_MODEL || "sonic-2").trim();

  const key = (process.env.WINMI_TTS_KEY || process.env.OPENAI_API_KEY || "").trim();
  const voice = (process.env.WINMI_TTS_VOICE || "onyx").trim();
  const model = (process.env.WINMI_TTS_MODEL || "gpt-4o-mini-tts").trim();

  const provider = cartKey ? "cartesia" : (key ? "openai" : null);

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true, service: "tts", configured: !!provider, provider,
      voice: cartKey ? cartVoice : voice, model: cartKey ? cartModel : model,
    });
  }
  if (req.method !== "POST") return res.status(200).json({ ok: false, error: "POST only" });
  if (!hasValidAppKey(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!provider) return res.status(200).json({ ok: false, configured: false, error: "no TTS key set" });

  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 900);
    if (!text) return res.status(200).json({ ok: false, error: "no text" });
    const speed = Math.min(1.4, Math.max(0.8, Number(body.speed) || 1.06));
    const lang = /^es/i.test(String(body.lang || body.language || "")) ? "es" : "en";

    const sendMp3 = (buf) => {
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(buf);
    };

    // ── Primary: Cartesia Sonic (most natural) ──────────────────────────────────────────────────
    if (cartKey) {
      const r = await fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: { "X-API-Key": cartKey, "Cartesia-Version": CARTESIA_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({
          model_id: cartModel,
          transcript: text,
          language: lang,
          voice: { mode: "id", id: cartVoice },
          output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
        }),
      });
      if (r.ok) return sendMp3(Buffer.from(await r.arrayBuffer()));
      const ctErr = await r.text();
      // Cartesia failed (bad voice id / key / quota). Fall back to OpenAI if we have a key, else report.
      if (!key) return res.status(200).json({ ok: false, provider: "cartesia", error: "cartesia " + r.status + ": " + ctErr.slice(0, 200) });
    }

    // ── Fallback: OpenAI audio/speech ───────────────────────────────────────────────────────────
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, voice, input: text, response_format: "mp3", speed }),
    });
    if (!r.ok) {
      if (model !== "tts-1") {
        const r2 = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "tts-1", voice, input: text, response_format: "mp3", speed }),
        });
        if (r2.ok) return sendMp3(Buffer.from(await r2.arrayBuffer()));
      }
      const t = await r.text();
      return res.status(200).json({ ok: false, error: "tts " + r.status + ": " + t.slice(0, 180) });
    }
    return sendMp3(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
