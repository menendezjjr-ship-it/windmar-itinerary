---
name: coordinator-routing
description: WindMar Itinerary Coordinator tab — job routing, the hand-built "My route" (pick order, live Leaflet map, drag-to-reorder, round-trip miles, Google Maps hand-off), the fixed HQ base, custom start address, and the real-time "ready to schedule" reports. Use when touching anything about picking, ordering, mapping, or reporting coordinator jobs in windmar-itinerary/index.html.
---

# WindMar Coordinator — job routing

The Coordinator tab (`coordHTML`, `index.html`) is where a coordinator turns "what's ready" into a
day's route. It has two jobs: **report** what's ready to schedule in real time, and let the
coordinator **hand-build and optimise a route** from those jobs. Precision matters here — a wrong
base, a wrong leg, or a stale list sends a crew to the wrong place. Everything below is verified
against the live code.

## The base (HQ)

```js
const HQ = { name:"WindMar Home Base — 6753 Kingspointe Pkwy, Ste 111, Orlando, FL 32819",
             lat:28.457575, lon:-81.438957 };   // index.html ~line 465
```

`28.457575,-81.438957` is the **exact US Census geocode** of 6753 Kingspointe Pkwy, Orlando FL
32819 (the old value `28.4576767,-81.4387948` was ~15 m off — don't reintroduce it). Every route
is a **closed loop that starts and ends at the base**, so round-trip miles and the Google-Maps
hand-off both anchor on it. To change the base, change this one const — nothing else hardcodes it.

### Custom start address
`routeOrigin()` returns the start point: a user-typed **custom** origin when one is set
(`S.coord.origin.mode==="custom"` with finite lat/lon), otherwise HQ. Keep the "add any address"
option — `coordOriginPicker()` + `coordSetOrigin(addr)` geocode the typed address with the same
geocoder the job pins use, and **fall back to HQ (never a wrong guess)** if it can't be found.
`routeOriginLabel()` is the short label ("base" / first two address parts).

## The hand-built route — `S.coord.pick`

`S.coord.pick` is an **array of item keys in click/drag order** (persisted to
`localStorage.wm_coord_pick` via `coordPickSave()`). The order IS the route. Key helpers:

| Function | What it returns / does |
|---|---|
| `coordItems()` | all coordinator jobs (ready service tickets + inspections), each with a stable `key` |
| `coordPickIndex(key)` | position of a job in the route, or `-1` |
| `coordPickedItems()` | picked jobs **in pick order**, annotated with `lat/lon` (from `GEO_CACHE`), `_legMi` (miles from previous stop) and `_hqMi`. Drops keys whose job left the list rather than routing to nowhere. |
| `coordPickMiles(list)` | total **round-trip** miles: sum of legs + last-stop→origin |
| `coordPickMapsUrl(list)` | Google Maps `dir` URL, origin=dest=base, **first 10 stops** as waypoints (Maps caps at 10) |
| `coordPickMove(fromKey,toKey)` | reorder: splice `fromKey` out, reinsert relative to `toKey` (after it when dragging down, before it when dragging up) |
| `coordPickOptimized()` | the picked stops re-ordered by least driving (greedy nearest-neighbour from the origin); un-geocoded stops keep their place at the end; returns keys |

Distances are straight-line **haversine** (`haversineMi`, R=3958.8 mi) — this is intentional (the
interview chose straight lines, not road routing). Don't swap in a routing API without being asked;
the miles shown and the map line must stay consistent.

## The live route map — `coordInitRouteMap()`

Rendered into `<div id="coordRouteMap">` inside `coordPickPanel()`. Draws, with Leaflet
(`L`, `wmBaseLayer()`):
- a 🏠 base marker at `routeOrigin()`,
- a numbered amber marker for each **geocoded** picked stop (number = pick order),
- a **closed-loop** amber polyline `base → stop1 → … → stopN → base`,
- `fitBounds` over all points, then `invalidateSize()` (needed because the panel is laid out after
  the map mounts).

It is re-created on every render from `_render()`:
```js
if (S.tab==="coordinator" && S.coord.pick && S.coord.pick.length){
  coordDragSetup();                               // one-time pointer handlers
  // geocode any picked stop missing coords (flat view doesn't run the tile geocode)…
  if (document.getElementById("coordRouteMap")) setTimeout(coordInitRouteMap, 0);
}
```
This runs in **any** coordinator view (flat list and by-area), not only inside a category tile.
Un-geocoded stops are skipped on the map and excluded from miles/Maps, and the panel says so.

## Drag-to-reorder — `coordDragSetup()`

Unified **mouse + touch** via Pointer Events (the interview chose computer AND tablet/phone), wired
**once** on `document` (`window._coordDragInit` guard) so it survives `render()` rebuilding
`#root`. Each stop row is `.coordStopRow[data-rowkey]` with a `⠿` handle
`[data-coorddrag]` (`touch-action:none` so a touch-drag doesn't scroll the page).
`pointerdown` on a handle captures the row; `pointermove` highlights the `.coordStopRow` under the
pointer (`elementFromPoint`); `pointerup` calls `coordPickMove(fromKey, toKey)`, which re-saves and
re-renders — the map and round-trip miles update live.

Gotchas:
- The handle is `data-coorddrag`; the row carries `data-rowkey`. Drop reads the **row's** `data-rowkey`.
- Keep `coordDragSetup()` idempotent — it's called on every coordinator render.
- The `✕` on a row is `data-action="coordPick"` (toggle off), a separate target from the drag handle.

## Real-time reports (the tiles)

The big-number tiles at the top of the tab (`coordBucketMeta`, `coordItems`) are the "ready to
schedule" report — ready service tickets + pending inspections, counted live from `S.coord.ready`
(service feed) and `S.proj` (inspections). Keep them real-time: `coordRefresh` reloads both feeds,
and when **one** feed fails the tab shows a partial-data warning instead of a confident short list
(`dispFeeds()`). Tapping a tile narrows the list to that bucket and switches it to the by-area
(proximity) grouping so a whole zone can be routed at once.

**Ready-to-Install is Deal-Stage-driven, not Installation-Stage-driven** (`api/zoho-ready.js`).
WindMar leaves an Installation's own `Stage` blank once the sale reaches the Install phase, so a
Stage-only query misses almost every ready job (the tile used to show ~1). The install set is built
from **Deals at Stage "Install"** (`INSTALL_DEAL_CRITERIA`), DL/RDL, FDA approved, not `(CL)` — each
deal's Installation record is pulled via `fetchInstallsByDeal` — merged with the live Permit-Approved
pool, then excluding already-scheduled (`installScheduled`: has install/confirmed date), parked
(`installParked`: On Hold / Cancel), and roofing (RL). `Install` is deliberately absent from
`COORD_CRITERIA` so these jobs show in the Install tile, not doubled into Coordination. Do NOT revert
to a Stage-only install query — most Installation records at the ready stages are stale (dead Deal).

## Deploy / verify

Standard Itinerary flow: commit as `menendezjjr-ship-it <menendezjjr@gmail.com>`, push `main`,
Vercel auto-deploys. **Verify at the site root `/`, not `/index.html`** — Vercel routes `/index.html`
differently and it will look like the deploy didn't land. The route map's tiles need the external
tile server, so a localhost-shim preview shows markers + polyline on a blank background (tiles load
fine live, same as the Install Map / Calendar Map). See [[service-tickets]] for the ticket fields
the coordinator list is built from.
