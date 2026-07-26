# demo-hygiene lane — live verification evidence (2026-07-26)

All captures are from real `next dev` servers (Maple :3000 local store,
Cadence :3001 + `supabase start`), real logins, real pipeline generation
(ANTHROPIC key), driven by Playwright.

## Criterion 24 — chips render / absent when empty

- `01-maple-chips-row.png` — Maple /vendo: 5 scenario cards, then the
  "OR TRY THIS" micro-label and 5 hairline pill chips (mockup §1 tiering).
- `07-cadence-chips-row.png` — Cadence /assistant: same tiering, 5 chips.
- Absent-when-empty is asserted in unit tests (page.test.tsx, ui
  lane-thread-picks) and was observed live while pre-generation was still
  running (chip row absent until the manifest filled).

## Criterion 25 — real pipeline output, asserted via store

- `criterion-25-store-assertions.txt` — output of the host-local
  `apps/<host>/assert-chips-store.mjs` scripts (dev servers stopped): every
  manifest entry resolves to a vendo_apps row owned by the demo subject,
  ui=tree with non-empty generated node trees, non-fixture app ids.
  5/5 PASS on each host.

## Criterion 26 — tap ⇒ attach ≤ 2s; cache miss ⇒ live generation

- `02-maple-chip-tap-attach.png` — "What bills hit next week?" attached in
  **295 ms** (Playwright-measured tap→app-card, badge overlaid on the shot;
  full measurement set in `timings.txt`), populated with REAL host data
  (scheduled payments + recurring charges).
- `08-cadence-chip-tap-attach.png` — "What filing deadlines hit next
  week?" attached in **242 ms** (badge overlaid; see `timings.txt`), fully
  data-populated (client deadline rows).
- `06a/06b-cache-miss-*.png` — reset erased the cache, chip tapped before
  regeneration finished: the prompt fell through to the REAL agent — 06a
  (+3 s) the live turn streaming, 06b (+28 s) the normal "Building your
  view…" generation progress UI with host tool calls succeeding. No error,
  no instant-attach shortcut.

## Criterion 28 — Reconnect (mockup §3)

- `03-reconnect-expired-row.png` — /vendo/workspace → Accounts: healthy
  Slack row keeps Disconnect only; expired Gmail row leads with the solid
  primary Reconnect (refresh glyph) + quiet Disconnect
  (`fl-btn-primary` / `fl-btn-quiet` verified on the live DOM).
- `04/05-reconnect-*.png` — clicking Reconnect fired
  POST /connections/initiate, polled to active, refreshed the list, and
  the row settled Connected. (Wire mocked via Playwright routes — no
  broker key locally; the flow code is the shipped completeConnection.)

## Criterion 27 — reset sweep

- Unit-proven (both hosts, fake ConnectionsService: 2 connections ⇒ 2
  disconnects + empty post-list; posture:false ⇒ no calls). Live resets in
  this session ran the posture:false path repeatedly without error (local
  posture has no broker). Broker-backed sweep runs the same list/disconnect
  wire the unit fake mirrors.
