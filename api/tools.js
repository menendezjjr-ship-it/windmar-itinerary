// /api/tools.js — el catálogo de herramientas del Itinerary, abierto a agentes externos.
//
// POR QUÉ EXISTE
// WinMI ya sabía responder "¿dónde está Crew #1S?" o "¿cuántos MSP hicimos en
// septiembre?" porque api/assistant.js tiene siete herramientas sobre Zoho,
// Samsara y SiteCapture. Ese trabajo estaba encerrado dentro del chat del
// Itinerary. Homie necesita las MISMAS respuestas, así que este endpoint publica
// el mismo catálogo y el mismo despachador en vez de obligar a nadie a
// reimplementarlos. Homie no sustituye a la herramienta: la usa.
//
// Se IMPORTAN TOOLS y runTool de assistant.js a propósito, no se copian. Dos
// copias divergen a la primera corrección y acaban contestando cosas distintas
// sobre los mismos datos — que es exactamente el tipo de error que no se puede
// permitir cuando lo que sale de aquí decide a qué casa va una cuadrilla.
//
//   GET  /api/tools                      -> catálogo (JSON Schema, listo para tool-calling)
//   POST /api/tools  {tool, input}       -> ejecuta una herramienta y devuelve su resultado
//
// Autenticación: el mismo header x-app-key que ya usan WinMI y el Service App.
//
// ALCANCE: SÓLO LECTURA. La allow-list de abajo es la frontera real — aunque
// algún día runTool incorpore herramientas que escriban, no saldrán por aquí
// hasta que alguien las añada a mano a esa lista. Escribir notas y mandar avisos
// está aprobado pero no implementado todavía: añadir una nota necesita resolver
// el DL al recordId interno de Zoho, y notify-crew está acoplado al flujo de
// Quick Job (sólo acepta confirmed/no_response), no es un aviso genérico. Las
// dos merecen su propia pasada en vez de un atajo contra producción.

import { TOOLS, runTool } from "./assistant.js";

export const config = { maxDuration: 60 };

const APP_API_KEY = (process.env.APP_API_KEY || "").trim();

// Deploy-safe, igual que en assistant.js: si la variable no está configurada el
// gate queda abierto, para que un despliegue sin la env no tire la integración.
function authorized(req) {
  if (!APP_API_KEY) return true;
  const k = String(req.headers["x-app-key"] || req.headers["X-App-Key"] || "").trim();
  return k === APP_API_KEY;
}

// La frontera de lo que se puede invocar desde fuera. Explícita y de solo
// lectura: se enumera lo permitido, nunca se excluye lo prohibido.
const READ_ONLY = [
  "search_projects",
  "get_job_details",
  "search_sitecapture",
  "crew_location",
  "closest_crew",
  "find_jobs",
  "count_jobs",
];

const EXPOSED = TOOLS.filter((t) => READ_ONLY.indexOf(t.name) >= 0);

// Un resultado enorme (p.ej. find_jobs sin filtros) puede reventar la ventana de
// contexto del agente que lo pida. Se recorta con un aviso explícito en vez de
// devolver algo truncado en silencio, para que el agente sepa que falta.
const MAX_BYTES = 180 * 1024;
function cap(result) {
  try {
    const s = JSON.stringify(result);
    if (s.length <= MAX_BYTES) return result;
    return {
      truncated: true,
      bytes: s.length,
      limit: MAX_BYTES,
      note: "Resultado demasiado grande; afina los filtros (fechas, ciudad, crew) y vuelve a pedirlo.",
      preview: s.slice(0, 4000),
    };
  } catch (e) {
    return result;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-key");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      version: 1,
      access: "read-only",
      auth: { header: "x-app-key", required: !!APP_API_KEY },
      invoke: { method: "POST", url: "/api/tools", body: { tool: "<name>", input: {} } },
      tools: EXPOSED,
    });
  }

  if (req.method !== "POST") {
    return res.status(200).json({ ok: false, error: "usa GET para el catálogo o POST para ejecutar" });
  }

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};

  const name = String(b.tool || b.name || "").trim();
  if (!name) {
    return res.status(200).json({ ok: false, error: "falta 'tool'", available: EXPOSED.map((t) => t.name) });
  }
  if (READ_ONLY.indexOf(name) < 0) {
    // Nombrar las disponibles convierte un error en algo que el agente puede corregir solo.
    return res.status(200).json({
      ok: false,
      error: `herramienta no disponible: ${name}`,
      available: EXPOSED.map((t) => t.name),
    });
  }

  const input = (b.input && typeof b.input === "object") ? b.input : {};
  const t0 = Date.now();
  try {
    const result = await runTool(name, input);
    return res.status(200).json({ ok: true, tool: name, ms: Date.now() - t0, result: cap(result) });
  } catch (e) {
    // 200 con ok:false a propósito: un agente distingue mejor "la herramienta
    // falló y aquí está el motivo" que un 500 que su cliente HTTP puede tragarse.
    return res.status(200).json({ ok: false, tool: name, ms: Date.now() - t0, error: String((e && e.message) || e) });
  }
}
