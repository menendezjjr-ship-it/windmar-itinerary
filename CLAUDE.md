# WindMar Itinerary — project brief for Claude

Dispatch / operations board for **WindMar Solar & Roofing** (Florida). Coordinators use it to see
installs + service tickets from Zoho CRM on a calendar, track crews, view plans/BOMs, get live crew
status updates, and see jobs/installs on maps. Companion app is **WindMar Field HUB** (the field-crew
PWA, a separate repo `windmar-operations`).

## Architecture (keep it simple — this is deliberately low-tech)
- **`index.html`** — the ENTIRE frontend: one file, inline `<style>` + `<script>`, vanilla JS. No build step, no framework.
  - Global state object `S`. `render()` (aka `_render`) rebuilds `#root.innerHTML` from scratch each call.
  - Clicks use event delegation via `data-action="..."` attributes handled in one switch.
  - `render(true)` = silent/background re-render (suppresses entry animations via `#root.noanim`) — use for auto-refresh so the UI doesn't blink.
  - Tabs are defined in the `TABS` array; each has a `fn` that returns HTML.
- **`api/*.js`** — Vercel serverless functions (Node, `export default async function handler(req,res)`).
  - `zoho-jobs.js` (installs + service tickets), `zoho-projects.js` (pipeline), `zoho-notes.js`, `zoho-file.js`, `zoho-attachments.js`, `crews.js`, `calendar.js` (cron), `sitecapture.js`, `geocode.js`, `push-cron.js` (cron).
- **`sw.js`** — service worker for Web Push notifications.
- **`dev-server.mjs`** — local-only dev server (gitignored). `node dev-server.mjs` serves `index.html` + runs `/api/*` locally on port 5180, reading Zoho creds fresh from `.env` each request.

## Deploy (IMPORTANT)
- Hosted on **Vercel**, project `windmar-itinerary` (team `team_xKEU3ta0qznCnNKBumJKJaz1`). **Auto-deploys on push to `main`.** Public site: https://windmar-itinerary.vercel.app
- **Commit author MUST be `menendezjjr-ship-it <menendezjjr@gmail.com>`** or Vercel blocks the deploy. Use:
  `git -c user.name="menendezjjr-ship-it" -c user.email="menendezjjr@gmail.com" commit ...`
- No build to run — just commit + push. Verify by curling the live URL or checking the Vercel deployment state = READY.
- Secrets (Zoho OAuth `ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN`, VAPID push keys) live ONLY in Vercel env vars. The repo is **public** — never commit secrets. `.env` is gitignored.

## Data sources
- **Zoho CRM, REST API v8** (NOT v2 — v2 rejects `between` on date fields). Modules: `Installation`, `Service_Ticket` (CustomModule40), `Deals`.
  - **Gotcha: Zoho caps a single search at 2,000 records** (`LIMIT_REACHED`). For all-time/bulk pulls, chunk the date range (e.g. 2-year windows) and merge. See `loadInstallMap()`.
  - `zoho-jobs.js` accepts `?only=install` / `?only=service` to skip the other module.
- **Shared Supabase** `lmlixmzmzpzgeggvywwb` — table `job_status_events` (crew status from Field HUB + estimator updates from plan-analyzer), `push_subscriptions`, `login_events`. Anon key is in the client. RLS blocks DELETE (rows are immutable).
- **Geocoding** (`api/geocode.js`): US Census one-line geocoder (primary, ~93% on FL addresses) + Nominatim/OSM fallback, FL-bounds validated, 30-day edge cache. `?nofallback=1` = Census-only (used for bulk to respect OSM rate limits). Client caches results in `localStorage.wm_geo_cache` and geocodes with a concurrency pool (`geocodeInto`, cc=12).

## Key features / conventions
- **Calendar** (`opsCalHTML`): views = Crew Grid (default), 🗺 Map, Month, List. Merges installs + service tickets, color-coded by crew; service = cyan + 🔧, installs filled by crew color.
  - **Crew name canonicalization**: Zoho returns mixed labels for the same crew (e.g. "In House #2"=Elite Crew #2, "T2 - Leonardo Torres"=Crew #1S, "Holi"=Crew H). Canonicalized server-side (`canonTeam` in zoho-jobs) and client-side so each crew appears once.
  - **Dedup**: a DL is often entered as BOTH an install and a service ticket — `dedupCalRecs()` collapses to one per DL+date.
  - **🗺 Map view**: pins this week's (or a single day's) jobs by crew; Week/Day toggle. **Install Map tab**: all-time completed installs (~2,300) as green pins. Both have hover tooltips + "Get Directions" (Google Maps deep-link). See `initPinMap`, `loadInstallMap`, `instMapHTML`.
  - **Service ticket detail** shows the full `Service_Description` (multi-line work order), not just the one-line type.
- **Crew Records** tab = permanent archive of crew status events (isolated per user & crew). Dashboard Crew Updates stay until acknowledged; ETAs clear daily.
- **Web Push**: notifies coordinators of crew updates even when the tab is closed (VAPID + `push-cron` every minute).
- **Login gate**: an MSAL (Microsoft) sign-in gate wraps the app (added by a parallel effort). Staff bypass exists. Don't remove it when editing.
- **Seasonal widget**: small top-right animated WindMar-logo badge.

## Working style here
- Match the existing terse, inline code style in `index.html` (dense one-liners, `esc()` for user text, `S.lang==="es"` for Spanish strings — the app is bilingual EN/ES).
- Test locally with `dev-server.mjs` (needs `.env` with Zoho creds) or verify against the live API after deploy.
- The user prefers: preview/verify before shipping when asked, honest reporting of precision/limits, and concise updates. Deploy only when asked.

## Crew roster (canonical labels)
Elite Crew #2, Elite Crew #3, Crew #1S, Crew #2S, Crew #3S, Crew H, Windmar Roofing. (Names map to specific people; see canonicalization maps in code.)
