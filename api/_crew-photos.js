// /api/_crew-photos.js — mirror crew status updates from Supabase into Zoho: the crew's note
// AND the photos they attached, onto the assigned job's record.
//
// WHY THIS EXISTS
// Crews post a status from the Field HUB. The note text was already mirrored to Zoho at submit
// time, but the photos never were — they only lived as public Supabase Storage URLs shown in the
// Itinerary crew feed. And when the submit-time note POST failed there was no retry, so some
// notes silently never landed either (DL2170, 2026-08-20 is a real example).
//
// This module fixes both, and is IDEMPOTENT so it can run every minute AND be re-run over old
// dates without ever duplicating anything:
//   • photos — the Zoho attachment File_Name is derived deterministically from the storage path,
//     so "already uploaded" is a name lookup against the record's existing Attachments.
//   • notes  — every note written here carries a [fh:<event-id-prefix>] marker. A record is
//     considered done if that marker is present, or (for notes written before the marker
//     existed) if some note already contains the crew's note text.
//
// The underscore prefix keeps Vercel from routing this file as an endpoint.

const API_DOMAIN = process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
const API_VERSION = process.env.ZOHO_API_VERSION || "v8";

// job_type → the Zoho module holding the assigned job. hq/lunch have no Zoho record at all.
export const MODULE_FOR = { service: "Service_Ticket", install: "Installation" };

const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // per photo; crew phone shots run ~0.5MB
const MAX_PHOTOS_PER_EVENT = 15;         // a runaway row can't stall the whole cron

// Storage URL → a stable, readable attachment name: DL6731_1787237895142_ve9v8q.jpg
// Deterministic on purpose: this name IS the idempotency key.
export function attachName(url, dl) {
  const last = String(url || "").split("?")[0].split("/").filter(Boolean).pop() || "photo.jpg";
  const safe = last.replace(/[^A-Za-z0-9._-]/g, "_").slice(-90);
  const pre = String(dl || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 20);
  return pre ? `${pre}_${safe}` : safe;
}

// Short marker so a re-run can recognize its own note. Uses the event's uuid prefix.
export function noteMarker(eventId) {
  return `[fh:${String(eventId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}]`;
}

const zh = (token) => ({ Authorization: `Zoho-oauthtoken ${token}` });

// Attachment File_Names already on the record. Returns null when the lookup itself fails, so the
// caller can skip rather than risk duplicating (an empty Set would look like "nothing attached").
async function existingAttachmentNames(token, module, recordId) {
  try {
    const url = `${API_DOMAIN}/crm/${API_VERSION}/${encodeURIComponent(module)}/${encodeURIComponent(recordId)}/Attachments?fields=id,File_Name&per_page=200`;
    const r = await fetch(url, { headers: zh(token) });
    if (r.status === 204) return new Set();
    if (!r.ok) return null;
    const d = await r.json();
    return new Set((d.data || []).map((a) => String(a.File_Name || "")));
  } catch (e) { return null; }
}

// Same contract as above: null means "could not determine", never "none".
async function existingNoteBlob(token, module, recordId) {
  try {
    const url = `${API_DOMAIN}/crm/${API_VERSION}/${encodeURIComponent(module)}/${encodeURIComponent(recordId)}/Notes?fields=Note_Title,Note_Content&per_page=200`;
    const r = await fetch(url, { headers: zh(token) });
    if (r.status === 204) return "";
    if (!r.ok) return null;
    const d = await r.json();
    return (d.data || []).map((n) => `${n.Note_Title || ""}\n${n.Note_Content || ""}`).join("\n---\n");
  } catch (e) { return null; }
}

async function postAttachment(token, module, recordId, bytes, filename, contentType) {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: contentType || "image/jpeg" }), filename);
  const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${encodeURIComponent(module)}/${encodeURIComponent(recordId)}/Attachments`, {
    method: "POST", headers: zh(token), body: fd,
  });
  const txt = await r.text();
  let d; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt }; }
  const rec = d && d.data && d.data[0];
  if (rec && rec.code === "SUCCESS") return { ok: true, id: rec.details && rec.details.id };
  return { ok: false, error: (rec && (rec.message || rec.code)) || String(txt).slice(0, 160) };
}

async function postNote(token, module, recordId, title, content) {
  const r = await fetch(`${API_DOMAIN}/crm/${API_VERSION}/${encodeURIComponent(module)}/${encodeURIComponent(recordId)}/Notes`, {
    method: "POST",
    headers: { ...zh(token), "Content-Type": "application/json" },
    body: JSON.stringify({ data: [{ Note_Title: String(title || "").slice(0, 120), Note_Content: content }] }),
  });
  const txt = await r.text();
  let d; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt }; }
  const rec = d && d.data && d.data[0];
  if (rec && rec.code === "SUCCESS") return { ok: true, id: rec.details && rec.details.id };
  return { ok: false, error: (rec && (rec.message || rec.code)) || String(txt).slice(0, 160) };
}

// The note body. Photo URLs are listed in the note itself so a Zoho user who is not in the
// Field HUB can still open every shot, even though they are attached to the record as well.
export function crewNoteContent(ev) {
  const photos = normPhotos(ev.photos);
  const who = [ev.created_by, ev.team].filter(Boolean).join(" · ");
  const head = [ev.dl_number, ev.customer].filter(Boolean).join(" ");
  return [
    who ? `${who} · ${ev.status}` : String(ev.status || ""),
    "@Jose Menendez @Maria Robles @Ronald Guiza @Harry Irizarry",
    head ? `Job: ${head}` : "",
    ev.note ? `\n${ev.note}` : "",
    photos.length ? `\n📷 ${photos.length} crew photo${photos.length === 1 ? "" : "s"} attached to this record:` : "",
    ...photos.map((u, i) => `  ${i + 1}. ${u}`),
    `\nSent ${ev.created_at || ""} from WindMar Field HUB ${noteMarker(ev.id)}`,
  ].filter(Boolean).join("\n");
}

// photos arrives as a real array from PostgREST, but a JSON string has been seen in the wild —
// the Itinerary's own photoStrip() normalizes both, so do the same here.
export function normPhotos(p) {
  let ph = p;
  if (typeof ph === "string") { try { ph = JSON.parse(ph); } catch (e) { ph = ph ? [ph] : []; } }
  if (!Array.isArray(ph)) return [];
  return ph.map((u) => String(u || "").trim()).filter(Boolean);
}

/**
 * Mirror a batch of job_status_events into Zoho.
 * @param events  rows from job_status_events
 * @param token   a Zoho access token
 * @param opts    { notes?:boolean }  notes default true; set false to only push photos
 * @returns       a per-event report; never throws
 */
export async function syncCrewToZoho(events, token, opts) {
  const doNotes = !opts || opts.notes !== false;
  const out = { considered: 0, records: 0, photosAttached: 0, photosSkipped: 0, photosFailed: 0, notesAdded: 0, notesSkipped: 0, details: [] };
  if (!Array.isArray(events) || !token) return out;

  for (const ev of events) {
    const module = MODULE_FOR[String(ev && ev.job_type || "").toLowerCase()];
    const recordId = String((ev && ev.job_id) || "").replace(/[^0-9]/g, "");
    const photos = normPhotos(ev && ev.photos);
    // Nothing to mirror: no Zoho record (hq/lunch), no id, or neither a note nor a photo.
    if (!module || !recordId || (!photos.length && !(ev && ev.note))) continue;
    out.considered++;

    const d = { id: ev.id, dl: ev.dl_number, module, recordId, attached: 0, skipped: 0, failed: 0, note: "skip" };
    try {
      if (doNotes) {
        const blob = await existingNoteBlob(token, module, recordId);
        if (blob === null) {
          d.note = "lookup-failed"; // never post blind — that is how duplicates happen
        } else {
          const marker = noteMarker(ev.id);
          const txt = String((ev && ev.note) || "").trim();
          const already = blob.includes(marker) || (txt.length > 12 && blob.includes(txt));
          if (already) { d.note = "present"; out.notesSkipped++; }
          else {
            const r = await postNote(token, module, recordId, `Field HUB — ${ev.status || "Update"}`, crewNoteContent(ev));
            if (r.ok) { d.note = "added"; out.notesAdded++; } else { d.note = "failed:" + r.error; }
          }
        }
      }

      if (photos.length) {
        const have = await existingAttachmentNames(token, module, recordId);
        if (have === null) { d.failed += photos.length; out.photosFailed += photos.length; d.photoErr = "attachment lookup failed"; }
        else {
          for (const url of photos.slice(0, MAX_PHOTOS_PER_EVENT)) {
            const name = attachName(url, ev.dl_number);
            if (have.has(name)) { d.skipped++; out.photosSkipped++; continue; }
            try {
              const pr = await fetch(url);
              if (!pr.ok) { d.failed++; out.photosFailed++; continue; }
              const ct = String(pr.headers.get("content-type") || "").toLowerCase();
              if (!/^image\//.test(ct)) { d.failed++; out.photosFailed++; continue; }
              const buf = Buffer.from(await pr.arrayBuffer());
              if (!buf.length || buf.length > MAX_PHOTO_BYTES) { d.failed++; out.photosFailed++; continue; }
              const ar = await postAttachment(token, module, recordId, buf, name, ct);
              if (ar.ok) { d.attached++; out.photosAttached++; have.add(name); }
              else { d.failed++; out.photosFailed++; d.photoErr = ar.error; }
            } catch (e) { d.failed++; out.photosFailed++; d.photoErr = String(e && e.message || e); }
          }
        }
      }
      out.records++;
    } catch (e) { d.err = String(e && e.message || e); }
    out.details.push(d);
  }
  return out;
}
