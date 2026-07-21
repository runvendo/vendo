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
| R-M5 | A fork+modify (title text) | FAIL | 160.7s | one-shot-fork-modify-collision | Same class third time. Step B (pin-preservation) unreachable (R-M5-A.png; no appdoc JSON was captured for this step — the failure shape on the wire matched R-M1/R-M3 exactly). |
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

| id | step | verdict | timing | class-if-fail | note |
|----|------|---------|--------|---------------|------|
| R-C1 | A fork+modify (percent complete) | FAIL | 33.0s | fork-without-modification | Edit reported SUCCESS but only forked: pin recorded, hero renders faithful (8 / Action needed / of 12), ship-diff EMPTY — the asked-for percent silently dropped (R-C1-A.png, R-C1-shipdiff.json). |
| R-C2 | A fork+modify WoW change [honesty] | FAIL | 43.8s | fork-without-modification | Same silent-drop shape: plain faithful fork, empty delta. No fabricated week-over-week number (honesty held) but the ask was neither delivered nor honestly declined (R-C2-A.png, R-C2-shipdiff.json). |
| R-C3 | A fork with badge 'Chase these' | PASS | 11.1s | — | ForkPin with FULL props {badgeLabel:"Chase these", missingCount:8, clientCount:12} — badge changed, counts truthful vs the live dashboard (blemish: literals, not tool-bound; they match the deterministic seed) (R-C3-A.png). |
| R-C3 | B amber-when-majority edit | PASS | 19.8s | — | Big number renders amber (8 > 12/2); delta = exactly 6 lines (AMBER const + majorityMissing conditional), comments intact, pin preserved. **Scenario PASS** (R-C3-B.png, R-C3-B-shipdiff.json). |
| R-C4 | A "add the hero as-is" | FAIL | 3.6s | fork-instead-of-host-node + fabricated-props | Forked instead of using the host catalog node, AND hard-coded props {missingCount:0, clientCount:0} → renders "0 … of 0 active clients need chasing", contradicting the live host (8 of 12). Data-honesty violation inside a faithful-looking fork (R-C4-A.png, R-C4-appdoc.json). |
| R-C5 | A hero + clients table composition | FAIL | 17.3s | edit-compile-failure | Edit rejected after retries: invalid reshape args, unknown prewired props (Surface gap/padding, DataTable data), never parsed to an <Edit>. No fork attempted; app unchanged. Generation-side class, not remix-specific (R-C5-appdoc.json). |
| R-C6 | A fork+modify (label text) | FAIL | 34.5s | one-shot-fork-modify-collision | The Maple collision class reproduces on Cadence: attempt 1 ForkPin+Island in one patch → "PinnedCadenceMissingDocsHerod69ea60a already exists"; attempt 2 unparseable. App unchanged (R-C6-appdoc.json). |

**Cadence half: 1/6 PASS** (R-C3).

## Score

**Baseline: 2/12 scenarios PASS** (R-M2 Maple plain-fork+style-edit chain, R-C3
Cadence props-fork+source-edit chain). Timing over the 14 measured
instructions: p50 ≈ 26s, p95 ≈ 170s (the ~3-minute tail is exactly the failed
fork+modify edits: two model attempts against a long edit context).

## Findings — fail classes ranked by leverage

1. **one-shot-fork-modify-collision** (R-M1, R-M3, R-M5, R-C6 — 4/12, plus the
   shape lurking behind class 2). "Remix X so that Y" in ONE instruction is the
   headline remix journey and it cannot succeed today: the model does the
   documented thing — `<ForkPin>` plus an `<Island name="Pinned…">` re-declaration
   in the same patch — and `applyForkPin` fails with `generated component
   "Pinned…" already exists` because the island op landed the component first.
   The retry then tends to emit a malformed non-`<Edit>` document. The user sees
   an error (Maple) after ~3 minutes. Engine-order/one-patch semantics, not
   model quality: highest-leverage fix target.
2. **fork-without-modification (silent drop)** (R-C1, R-C2 — 2/12). The other
   resolution of the same tension: the model emits ONLY `<ForkPin>`, the edit
   "succeeds", and the requested modification vanishes without an error or an
   honest note. Worse than class 1 for trust — the user gets a plain copy and
   no signal.
3. **fork-instead-of-host-node** (R-M4, R-C4 — 2/12). "Add the host's card
   as-is" forks (pin + review burden) instead of composing the host catalog
   node. On R-C4 it compounds with **fabricated props** (0/0 counts
   contradicting the live dashboard). Note the design tension (finding F4
   below).
4. **fork-props-clobber-sample-seed** (R-M6 — 1/12, plus the R-C4 zeros and the
   post-drift crash in the diagnostic). Node props on a pinned component
   REPLACE the baseline sampleProps wholesale; partial props (only
   `initialRange`) crash the captured component ("Cannot read properties of
   undefined (reading 'length')") as an error blob. Merge-with-sampleProps (or
   prompting full props) would eliminate the crash mode.
5. **edit-compile-failure** (R-C5 — 1/12). Reshape/prewired-prop errors;
   generation-side, tracked by the generation eval's classes.

### Machinery findings (non-scored)

- **F1 — drift→rebase works end-to-end** (supplementary diagnostic): `vendo
  sync` warns on recapture; `pin-drift` reports `baseline-changed` with both
  hashes; ship-diff flips `drifted:true`; the renderer banner appears; rebase
  is EXPLICIT-only and replays recorded pin intents through the real edit path
  — the rebased fork carried both the host's new label and the user's earlier
  badge-color edit, and drift cleared. The strongest part of the remix stack.
- **F2 — a host update can crash outstanding forks** whose nodes carry partial
  props (they lose nothing they had — they were already crashed by class 4 —
  but R-M6's app showed drift banner + error blob together: the drifted state
  compounds rather than degrades gracefully).
- **F3 — comment stripping on island re-declaration** (R-M2-B): the model
  retypes the fork source without the host's comments — the 2-line color
  change shipped with ~24 comment-deletion diff lines. Review noise + lost
  provenance docs in every edited fork.
- **F4 — catalog/slot duality**: both demo slots are ALSO host catalog
  components whose props schemas demand live numbers (`valueCents`+`series`,
  `missingCount`+`clientCount`) that no host tool supplies. The "correct"
  no-fork answer (host node) therefore forces the model to invent props, while
  the fork route gets truthful seed numbers via furnishings sampleProps — the
  bar and the engine currently pull in opposite directions on R-M4/R-C4-shaped
  asks. Worth a design ruling before the next wave.
- **F5 — CSP blocks the jail stylesheet**: every app open logs `Loading the
  stylesheet '/vendo/tailwindcss' violates … style-src 'unsafe-inline'` (4-10
  console errors per page). Cosmetic today (captured components inline their
  styles) but it is a real, repeated console error on the captured-styles path.
- **F6 — no busy state on VendoPage create** (Cadence): the Create button never
  shows progress; the app card appears only when generation completes.

## Harness notes

- `driver.mjs` (this directory) is the exact instrument; states/cookies live in
  the session scratchpad, never committed. Two in-run harness fixes (not
  tuning): Maple app selection by list index (all six base apps share the name
  "My Corner" — chips are name-only), and the Cadence open-wait not requiring
  an iframe (pure-prewired apps render none).
- DRIFT-notice.png shows R-M6's app (any fork of the slot drifts at once);
  DRIFT-after-rebase-3.png is the rebased R-M2 app. Intermediate
  DRIFT-after-rebase{,-2}.png predate the index-selection fix and show R-M6's
  drifted app — kept for honesty.
- Post-run harness fixes (from PR review, AFTER the scored run — the evidence
  above was captured with the pre-fix driver): portable scratch/Playwright
  resolution, wire-based Cadence create wait (its button has no busy state,
  finding F6), busy-label appearance guard before the absence wait on Maple,
  and Cadence open disambiguation by list index for same-name cards.
