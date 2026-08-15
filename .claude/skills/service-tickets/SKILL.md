---
name: service-tickets
description: WindMar Zoho Service Ticket structure — field names, MSP detection, reserved time blocks, job-type codes (DL/RDL/RL/S), the numbered description template, and notes. Use when reading, rendering, filtering, or colour-coding service tickets in windmar-itinerary or windmar-operations.
---

# WindMar Service Tickets

Everything here was verified against live Zoho data. Where a rule looks arbitrary, the reason it
is arbitrary is written down — those are the parts that get "fixed" back into bugs.

`settings/fields` is **scope-blocked** for our OAuth token (`OAUTH_SCOPE_MISMATCH`). Get field
metadata through the Zoho MCP `getFields` tool instead, not the REST API.

## Modules

| What | API name | Notes |
|---|---|---|
| Service Ticket | `Service_Ticket` | CustomModule40 |
| Post-Installation | `Final_Inspectin` | CustomModule11. The Deal-linked record; crew notes also land here |
| Installation | `Installation` | |
| Project | `Deals` | |

## Job type codes

The code comes off the DL number prefix. **`RDL` is not a re-install.**

| Code | Type | Colour | Shown? |
|---|---|---|---|
| `DL` | install | `#1D429B` | yes |
| `RDL` | **install** | `#1D429B` | yes |
| `S` | service | `#0EA5E9` | yes |
| `RL` | roofing | `#DC2626` | **hidden** in the Itinerary board + calendar |

Evidence for RDL: 289 RDL deals, 287 of them Pipeline "Solar", `Existing_System_Size_kW` null on
every one, and the roof completes before the install. A genuine re-install is
`Area_of_Service = "(14) Remove/Re-install System"` — 7 records, 6 `DL` + 1 `RL`, **zero `RDL`**.
Any `/re-?roof/` or `/re-?install/` regex over the scope text will misclassify RDL. Use the code.

`RL` is hidden client-side in the Itinerary only — the same shared feed serves the Windmar
Roofing crew's own Field HUB calendar, where they need to see their jobs.

## MSP

MSP tickets are violet `#9333EA`, not the normal service blue. Detect from the two explicit
category fields only — never from free text:

```js
const svcType1 = (r.Service_Type1 && typeof r.Service_Type1 === "object" ? r.Service_Type1.name : r.Service_Type1) || "";
const svcArea  = (r.Area_of_Service && typeof r.Area_of_Service === "object" ? r.Area_of_Service.name : r.Area_of_Service) || "";
const isMsp = /\bmsp\b/i.test(String(svcType1)) || /\bmsp\b/i.test(String(svcArea));
```

Both fields arrive as either a bare string or `{name, id}` depending on the endpoint. Handle both.
`\b` matters — without it "MSPX" and words containing "msp" match.

## Reserved time blocks

**1 block = 2 hours.** 4 blocks = 8h = the crew's whole day. This is what stops a coordinator
double-booking, so it belongs on the chip itself, not behind a hover.

Per-visit fields, `n` = visit number 1..6:

```
Number_of_Reserved_Time_Blocks_<n>     // count
Reserved_Block_Time_<n>                // window, e.g. "8:00 AM - 4:00 PM"
```

**Naming quirk:** visit 1's count field is `Number_of_Reserved_Time_Blocks_1`, and
`Reserved_Block_Time_3` breaks the otherwise-regular pattern. Read the real names from
`SERVICE_FIELDS` in `api/zoho-jobs.js`; do not generate them in a loop.

Live distribution: 90 tickets × 2h, 91 × 4h, 2 × 6h, 52 × 8h.

```js
function visitBlocks(r, n) {           // → {blocks, hours, blockWindow}
  const blocks = Number(r[`Number_of_Reserved_Time_Blocks_${n}`] || 0);
  return { blocks, hours: blocks * 2, blockWindow: r[`Reserved_Block_Time_${n}`] || "" };
}
```

## Description template

Tickets follow a numbered template. The crew card parses it structurally — **no model rewrites
it.** Every line displayed is lifted verbatim from Zoho. On electrical work an invented step is a
safety issue, not a cosmetic one.

```
1. <the problem>
2. <the house>
   - need access / no need access
   - <other access notes>
3. <what to do>
   - <step>
   - <step>
```

Sections 1 and 3 are required; a ticket that does not match returns `null` and the caller shows
the **original text verbatim** rather than a half-parsed guess. The rendered card also keeps the
raw text one tap away in a `<details>`.

Implementations, kept in sync:
- `windmar-itinerary/index.html` — `crewCardParse` / `crewCardSvg` / `crewCardHTML`
- `windmar-operations/src/crewCard.js` — `crewCard` / `crewCardSvg` / `CREW_CARD_T`

The step diagram is emitted as shapes + escaped text only: no script, no `href`/`src`, no
`foreignObject`.

## Notes

Notes are read and written on the ticket itself:

- Read: `GET /api/zoho-notes?module=Service_Ticket&id=<recordId>` (both apps)
- Write: `api/zoho-add-note.js` (Itinerary), `api/zoho-note.js` (Field HUB — a service note goes
  to **both** the `Final_Inspectin` record and the `Service_Ticket`)

Zoho stores note bodies as HTML with `crm[user#id#name]crm` mention tokens; strip both.

Writing needs `ZohoCRM.modules.notes.CREATE` scope. If the token lacks it the write returns
`{ok:false}` and the Supabase + email path still works — never let it break the caller.

## Multi-visit ids

The calendar fans a multi-visit ticket into one record per visit, with ids suffixed `-v2`, `-v3`…
Strip `/-v\d+$/i` before using an id against Zoho. Visit 1 keeps the bare id.

## Gotchas that have already caused bugs

- **A helper that renders the right thing is worthless if nothing calls it.** `calChip` carried
  the completion ✓ and the duration badge for weeks while the Crew Grid and Month views built
  their own chips inline. Grep for call sites, not just definitions.
- `array.map(fn)` passes `(element, index)`. `calRow(r, cont)` and `calChip(r, cont)` take a
  boolean 2nd param — `list.map(calRow)` silently feeds it the index.
- Module allow-lists: use `array.indexOf`, not an object lookup. `MODULES["constructor"]` is
  truthy through the prototype chain.
- The crew ETA feed only ever holds **today**. Any view that pages through dates must not read it
  for other days.
- Vercel serves `cache-control: max-age=0, must-revalidate` — a reload gets the new build, but an
  already-open tab keeps running the JS it loaded. Verifying the deploy is not verifying the
  feature; say which one you did.
