// /api/notify-crew.js — a coordinator resolved a Quick Job claim; tell the CREW via Teams.
//
// POST { num, customer, address, crew_name, miles, status:'confirmed'|'no_response', coordinator? }
//   -> posts a card to the crew channel behind TEAMS_CREW_WEBHOOK_URL
// GET  ?diag=1  -> { configured, flavor, host } (booleans + bare domain only — never the URL; it's a credential).
//
// Webhook flavour is chosen from the URL host, not guessed (posting the wrong shape "succeeds" but
// renders nothing):
//   Workflows / Power Automate (*.logic.azure.com, *.powerplatform.com) -> Adaptive Card in { type:"message", attachments:[] }
//   Connectors                 (*.webhook.office.com)                    -> legacy MessageCard

const HOOK = (process.env.TEAMS_CREW_WEBHOOK_URL || "").trim();
const isLegacy = (u) => /webhook\.office\.com|outlook\.office(365)?\.com/i.test(u);
const S = (v, n) => String(v == null ? "" : v).replace(new RegExp("[\\u0000-\\u001F\\u007F]", "g"), " ").trim().slice(0, n || 200);

function fields(b) {
  const confirmed = b.status === "confirmed";
  return {
    confirmed,
    num: S(b.num, 40) || "—",
    customer: S(b.customer, 120) || "—",
    address: S(b.address, 200) || "—",
    crew: S(b.crew_name, 80) || "Crew",
    miles: b.miles != null && b.miles !== "" ? (Number(b.miles) || 0).toFixed(1) + " mi" : "",
    coordinator: S(b.coordinator, 80),
    title: (confirmed ? "✅ Confirmed" : "⚠️ No response from homeowner") + " — " + (S(b.num, 40) || "Quick Job"),
    line: confirmed
      ? "The coordinator booked it with the client. Head over to " + (S(b.customer, 120) || "the customer") + "."
      : "The coordinator couldn't reach the homeowner yet — hold off until they confirm.",
    color: confirmed ? "Good" : "Warning",
  };
}

function adaptiveCard(f) {
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          { type: "TextBlock", text: f.title, weight: "Bolder", size: "Medium", color: f.color, wrap: true },
          { type: "TextBlock", text: f.line, isSubtle: true, spacing: "None", wrap: true },
          { type: "FactSet", facts: [
            { title: "Customer", value: f.customer },
            { title: "Address", value: f.address },
            { title: "Crew", value: f.crew + (f.miles ? " · " + f.miles : "") },
          ].concat(f.coordinator ? [{ title: "Coordinator", value: f.coordinator }] : []) },
        ],
      },
    }],
  };
}

function messageCard(f) {
  return {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    themeColor: f.confirmed ? "16A34A" : "F89B24",
    summary: f.title,
    title: f.title,
    text: f.line,
    sections: [{ facts: [
      { name: "Customer", value: f.customer },
      { name: "Address", value: f.address },
      { name: "Crew", value: f.crew + (f.miles ? " · " + f.miles : "") },
    ].concat(f.coordinator ? [{ name: "Coordinator", value: f.coordinator }] : []) }],
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({
      configured: !!HOOK,
      flavor: !HOOK ? null : (isLegacy(HOOK) ? "connectors" : "workflows"),
      host: HOOK ? (HOOK.split("/")[2] || "") : null,
    });
  }
  if (req.method !== "POST") return res.status(200).json({ ok: false, error: "POST only" });
  if (!HOOK) return res.status(200).json({ ok: false, configured: false, error: "TEAMS_CREW_WEBHOOK_URL is not set on this project" });

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  if (b.status !== "confirmed" && b.status !== "no_response") {
    return res.status(200).json({ ok: false, error: "status must be 'confirmed' or 'no_response'" });
  }
  const f = fields(b);
  const legacy = isLegacy(HOOK);
  const payload = legacy ? messageCard(f) : adaptiveCard(f);
  if (b.test) {
    if (legacy) { payload.title = "TEST — " + payload.title; }
    else { payload.attachments[0].content.body.unshift({ type: "TextBlock", text: "TEST — connection check, no action needed", weight: "Bolder", color: "Warning", wrap: true }); }
  }

  try {
    const r = await fetch(HOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const txt = (await r.text().catch(() => "")).slice(0, 200);
    const ok = r.ok || r.status === 202;
    return res.status(200).json({ ok, status: r.status, flavor: legacy ? "connectors" : "workflows", response: txt });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
