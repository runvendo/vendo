# REMIX baseline run — 2026-07-21

Baseline scoring run for the frozen remix eval (`docs/eval/REMIX.md`), run ONCE,
one attempt per measured instruction, zero tuning. Main @ 4cb6cdb6 (branch
`yousefh409/remix-eval`, docs-only on top).

- Hosts: production boots (`next build && next start`), one at a time —
  demo-bank on :3100, demo-accounting on :3300 (nonstandard ports to avoid the
  sibling generation session's 3000/3200).
- Browser: dedicated headless Chromium (Playwright 1.61.1) via `driver.mjs` in
  this directory — never the shared MCP browser. Maple edits go through the
  `/vendo/apps` edit box; Cadence edits invoke the same `POST /apps/:id/edit`
  wire call from the page context (its shipped VendoPage has no edit input).
- Evidence: `shots/` — full-page screenshots per step, ship-diff JSON, app-doc
  JSON, console-error logs. Reference shots of the host originals:
  `shots/ref-maple-home.png`, `shots/ref-cadence-home.png`.
- Timing = submit → updated app visible (edit-button busy interval for Maple
  UI edits; wire-call duration for Cadence edits).

## Maple (demo-bank) — R-M1–R-M6

| id | step | verdict | timing | class-if-fail | note |
|----|------|---------|--------|---------------|------|
| R-M1 | A fork+modify ($-change line) | FAIL | 171.6s | one-shot-fork-modify-collision | Edit rejected after 2 attempts: attempt 1 emitted `<ForkPin>` + `<Island name="PinnedMapleNetWorthCardec18f36c">` in ONE patch → engine error `generated component … already exists`; attempt 2 didn't parse (`expected a single <Edit>… document`). Error surfaced to user; app unchanged, no pin (R-M1-A.png, R-M1-appdoc.json). |
| R-M2 | A plain fork | PASS | 3.4s | — | Pin recorded (base e53f5915…), ship-diff delta EMPTY (0 bytes), fork renders pixel-faithful vs ref-maple-home.png: $54,907.15, green badge, working range switcher, area chart (R-M2-A.png, R-M2-A-shipdiff.json). |
| R-M2 | B badge blue edit | PASS | 73.6s | — | Badge renders blue; pin preserved; functional delta = exactly `POS`/`POS_BG` color constants. Blemish: the model re-declared the island with ALL comments stripped → 24 comment-deletion lines of diff noise around the 2-line change (R-M2-B.png, R-M2-B-shipdiff.json). **Scenario PASS.** |
| R-M3 | A fork+modify (1M/1Y only) | FAIL | 153.5s | one-shot-fork-modify-collision | Identical failure shape to R-M1 (ForkPin+Island collision, then unparseable retry). App unchanged; step B unreachable (R-M3-A.png, R-M3-appdoc.json). |
| R-M4 | A "add the card exactly as it is" | FAIL | 3.9s | fork-instead-of-host-node | Render is faithful (sample-seeded fork, R-M4-A.png) but the engine FORKED (pin + PinnedMapleNetWorthCardec18f36c) instead of using the host catalog `MapleNetWorthCard` node the bar requires for a covered-verbatim ask (R-M4-appdoc.json). See finding F4 on the catalog/slot duality. |
| R-M5 | A fork+modify (title text) | FAIL | 160.7s | one-shot-fork-modify-collision | Same class third time. Step B (pin-preservation) unreachable (R-M5-A screenshots/appdoc analogous). |
| R-M6 | A fork+modify (default 1Y) | FAIL | 4.2s | fork-props-clobber-sample-seed | The model forked WITH `props={{initialRange:"1Y"}}` — a legitimate move (the prop exists) — but node props REPLACE the baseline sampleProps wholesale, so `valueCents`/`series` were undefined and the fork crashed: “PinnedMapleNetWorthCardec18f36c: Cannot read properties of undefined (reading 'length')” (R-M6-A.png). Pin recorded but render is an error blob → drift steps B/C not reachable in-scenario. |

**Maple half: 1/6 PASS** (R-M2).

### Supplementary drift→rebase diagnostic (out-of-set, not scored)

R-M6 failed before its drift steps, so the drift machinery was exercised
diagnostically on R-M2's healthy forked app (`app_4a029b01…`), exactly per the
protocol staging: host label “Total balance”→“Total net worth” in
`net-worth-view.tsx`, `vendo sync` recapture (hash e53f5915… → a41d162f…),
host restart; then reverted and re-synced afterwards (hash verified back to
e53f5915…, tree clean).

- `vendo sync` itself reported the drift: “pins: 0 captured, 1 drifted …
  existing forks stay on the old capture until each owner rebases”.
- `GET /pin-drift` reported `baseline-changed` with both hashes; ship-diff
  flipped `drifted: true` (DRIFT-shipdiff.json).
- The renderer's drift notice appeared on a drifted fork: “The host updated
  "MapleNetWorthCard" since it was remixed here. Ask the agent to rebase…”
  (DRIFT-notice.png — shows R-M6's drifted app; every fork of the slot drifts
  at once).
- Rebase was explicit only (`POST /rebase-pin`): `status:"rebased"`, new base
  = a41d162f…, and the recorded pin intent “make the change badge blue instead
  of green” REPLAYED through the real edit path — the reopened fork shows BOTH
  the host's new “TOTAL NET WORTH” label AND the blue badge, drift notice
  gone, `pin-drift` → `[]` (rebase-app_4a029b01….json, DRIFT-after-rebase-3.png).
- **New bug found while staging**: a drifted, never-rebased fork whose node
  carries partial props loses its sample-seed and crashes (finding F2/F3
  below); R-M2's propless fork kept rendering via furnishings sampleProps.

## Cadence (demo-accounting) — R-C1–R-C6

(rows below)

## Findings (fail classes ranked by leverage)

(final summary at bottom after both halves)
