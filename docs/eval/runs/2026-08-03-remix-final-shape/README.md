# REMIX frozen 12 — re-run on the final wrapper shape (2026-08-03)

Scoring re-run of the frozen remix eval (`docs/eval/REMIX.md`), run ONCE, one
attempt per measured step, zero tuning. Main @ 4f64c01e (every remix lane
merged: W0, W1a–e, WFIX, WFIX2; branch `remix/w2-eval-rerun`, docs-only on
top). First run on the shipped 2026-08-02 final shape: the `<Remixable>`
wrapper is the whole remix API, so fork scenarios are invoked through the
WRAPPER surface — the plain add-as-is gesture is the real ✦ pill click; an
instruction-carrying gesture is the same appId-less `POST /apps/fork-pin`
wire call with the frozen protocol's `{ slot, instruction }` body, invoked
from the page context with the session's credentials. The captured wrapper
slots are the same two host components under their presentational-view names:
Maple `NetWorthView` (the net-worth card view), Cadence `MissingDocsHero`.

- Hosts: production boots (`next build && next start`, never dev) — demo-bank
  on :4310 (Auth.js sign-in, local PGlite store), demo-accounting on :4311
  (`DEMO_AUTOLOGIN=1`), one host at a time. Real inference (Anthropic,
  claude-sonnet-4-6, explicit key).
- Browser: dedicated headless Chromium (Playwright) via `driver.mjs` in this
  directory; `probe.mjs` is the judge's read-only instrument (clicks inside
  the rendered fork's jail to verify interactive fidelity — never edits,
  never forks).
- Per the frozen protocol: fresh base app per scenario from the fixed base
  prompt (staging); prior fork apps deleted between scenarios (the appId-less
  gesture dedupes per subject+slot, so a leftover fork would swallow the next
  gesture); Maple text edits through the `/vendo/apps` edit box; Cadence
  edits via the same `POST /apps/:id/edit` wire call from page context,
  judged on the reopened rendered app. Ship-diff judged in Maple's Ship
  review panel (screenshots) and over the wire on both hosts (`wire/`).
- Reference shots of the host originals: `shots/ref-maple-home.png`,
  `shots/ref-cadence-home.png`.
- Timing = gesture/edit submit → wire complete (an instruction-carrying
  gesture executes the deterministic fork plus the scoped edit inside the one
  wire call); add ~6s of reload+jail paint for “visible in place”.
- Engine #631 (binding-in-string interpolation) never blocked a measured
  step in this run.

## Maple (demo-bank) — R-M1–R-M6

| id | step | verdict | timing | class-if-fail | note |
|----|------|---------|--------|---------------|------|
| R-M1 | A fork+modify ($-change line) | PASS | 108.8s | — | Pin recorded (base 52ce29c1…); fork faithful vs ref; “+$1,587.26” rendered beside the change badge, derived from the series window and tracking the selected range (1Y click → “+$4,192.78”, R-M1-A-switcher-1Y.png); ship-diff = exactly that addition; switcher still switches inside the jail. **Scenario PASS.** |
| R-M2 | A plain ✦ pill fork | PASS | 0.8s | — | Real pill click; pin recorded, fork mounts jailed in place, ship-diff delta EMPTY (0 lines), pixel-faithful vs ref (R-M2-A.png, wire/R-M2-A-shipdiff.json). |
| R-M2 | B badge blue edit | PASS | 84.6s | — | Rendered badge flips green→blue (pixel-sampled #1e7f53/#e7f4ee → #1d4ed8/#eff6ff); delta = exactly the POS/POS_BG color constants, comments intact (the baseline’s comment-stripping noise is gone); pin preserved. **Scenario PASS.** |
| R-M3 | A fork+modify (1M/1Y only) | PASS | 84.5s | — | Switcher offers only 1M/1Y (plus the entailed initialRange fallback 3M→1M); fork faithful. |
| R-M3 | B caption edit | PASS | 88.9s | — | “Excludes pending transactions” caption under the chart; both changes in one minimal delta; 1Y still switches in the jail (R-M3-B-switch-1Y.png; R-M3-B-after-1Y-click.png is a dud in-run probe shot, superseded, kept for honesty); pin preserved. **Scenario PASS.** |
| R-M4 | A “add the card exactly as it is” | FAIL | 10.1s | edit-compile-failure | The edit never parsed (`expected a single <Edit>…</Edit> document; malformed-expression`), error surfaced in the edit box, app unchanged (wire/R-M4-A-edit.json). NO pin minted — no-silent-fork held — but an error box is not honest handling of the ask. Staging note: the base create over-delivered a full dashboard (already containing a MapleNetWorthCard host node) from the fixed “just a heading” prompt; the measured verdict is the parse failure either way. |
| R-M5 | A fork+modify (title text) | PASS | 84.7s | — | One-line diff `Total balance` → `Savings power`; renders faithfully (R-M5-A.png). |
| R-M5 | B accounts table below the card | FAIL | 57.8s | edit-compile-failure | Edit never parsed (invalid `<Insert>` gap + invalid reshape args), error surfaced, app unchanged — no table (wire/R-M5-B-edit.json). Fork stayed byte-identical and pin intact, but only because nothing was applied. **Scenario FAIL.** |
| R-M6 | A fork+modify (default 1Y) | PASS | 84.3s | — | One-line initialRange diff; fork loads with 1Y active — the baseline’s props-clobber crash shape did not occur (no node props minted; live wrapper props flow in). |
| R-M6 | B host drift staged (label change, re-sync, restart) | PASS | reopen | — | Drift notice renders above the still-healthy fork (“The host updated "NetWorthView" … Ask the agent to rebase …”); `pin-drift` → `baseline-changed` with both hashes; ship-diff `drifted:true` (R-M6-B-drift-notice.png, wire/R-M6-B-pindrift.json). Sync itself warned at recapture. |
| R-M6 | C explicit rebase | PASS | 95.1s | — | `POST /rebase-pin` → `status:"rebased"`, new base 47f87b80…, the (A) intent replayed; reopened fork shows BOTH the host’s new “TOTAL NET WORTH” label AND the 1Y default; drift notice gone, `pin-drift` → `[]`; ship-diff clean vs the new baseline with the same minimal 1Y delta. Staging reverted; baseline hash verified back to 52ce29c1…, tree clean. **Scenario PASS.** |

**Maple half: 4/6 PASS** (R-M1, R-M2, R-M3, R-M6).

## Cadence (demo-accounting) — R-C1–R-C6

| id | step | verdict | timing | class-if-fail | note |
|----|------|---------|--------|---------------|------|
| R-C1 | A fork+modify (percent complete) | PASS | 37.1s | — | Fork faithful in place; adds “4 of 12 clients fully complete · 33% complete”, derived from the hero’s own counts; ship-diff = that addition only (R-C1-A.png). **Scenario PASS.** |
| R-C2 | A fork+modify WoW change [honesty] | PASS | 44.4s | — | No week-over-week tool exists; the delta adds an optional `weekOverWeekDelta` prop whose region renders ONLY when a host supplies the value — rendered region omitted, nothing fabricated, no invented node props (wire/R-C2-appdoc.json). The bar sanctions omission (“omits the region or says so”); blemish: silence rather than a visible “unavailable” note. **Scenario PASS.** |
| R-C3 | A fork badge ‘Chase these’ | PASS | 29.7s | — | Badge changed via the source default, counts stay live through wrapper props (no frozen literals this time — the baseline’s blemish gone). |
| R-C3 | B amber-when-majority edit | PASS | 28.3s | — | Big number renders amber (8 > 12/2), conditional driven by the hero’s own counts; two-change minimal delta; pin preserved. **Scenario PASS.** |
| R-C4 | A “add the hero as-is” | PASS | 3.5s | — | NO pin; the hero is the HOST catalog node `CadenceMissingDocsHero` with BOTH required data props tool-bound (`missingCount`/`clientCount` ← `$path` into `getDashboard` — the exact F4-ruled PASS); renders live-true 8 of 12 (R-C4-A.png). Blemish: unrequested cosmetic `badgeLabel:"Need chasing"` literal (host default “Action needed”) — no data invented. **Scenario PASS.** |
| R-C5 | A hero + outstanding-docs table | PASS | 72.0s | — | No pin; hero as tool-bound host node on top; “Clients with outstanding documents” table below composed from `listDeadlines` rows (real clients, real statuses, R-C5-A.png). Blemishes: same `badgeLabel` literal; the generated table island hardcodes `new Date("2026-08-03")` as “now” for its “(3d away)” annotations — correct today, stale tomorrow. **Scenario PASS.** |
| R-C6 | A fork+modify (label text) | PASS | 27.2s | — | One-line label diff `Clients missing documents` → `Clients still owing documents`; fork faithful (R-C6-A.png). |
| R-C6 | B donut next to it | FAIL | 67.6s | edit-lands-inside-pin | The edit implanted the donut INSIDE the pinned component (+223 lines to the pin; fork NOT byte-identical; wire/R-C6-B-shipdiff.json) instead of composing it outside — and the in-fork `tools.list_client_documents` fetch renders an empty “No data” region (R-C6-B.png). Pin intact, label change survives, no fabricated figures — but the byte-identity bar is explicit. **Scenario FAIL.** |

**Cadence half: 5/6 PASS** (R-C1, R-C2, R-C3, R-C4, R-C5).

## Score

**9/12 scenarios PASS** (baseline 2/12). Timing over the 18 measured
wire-timed steps: p50 ≈ 63s, p95 ≈ 109s. Instruction-carrying gestures — the
headline “remix X so that Y” journey that could not succeed at baseline —
went 8/8 on the fork+scoped-edit mechanics (R-M1, R-M3-A, R-M5-A, R-M6-A,
R-C1, R-C2, R-C3-A, R-C6-A); every fork was deterministic, faithful, and
pin-recorded, with honest minimal deltas and no comment-stripping noise.

## Failure classes (2 classes, 3 step-fails)

1. **edit-compile-failure** (R-M4-A, R-M5-B — 2/12 scenarios lost). The
   model’s edit document fails to parse/compile (malformed `<Edit>`, invalid
   insert/reshape ops); the error is surfaced and the app stays unchanged.
   Both occurrences are Maple TEXT edits through the edit box; the same class
   cost R-C5 at baseline. Generation-side (the generation eval’s territory),
   not remix machinery: the fork/pin path was not involved in either loss.
2. **edit-lands-inside-pin** (R-C6-B — 1/12 lost, NEW class). A “add X next
   to it” edit on a fork app modifies the pinned component itself instead of
   composing a sibling outside it, breaking the byte-identity bar (and its
   in-fork data fetch rendered an empty state). The pin survives; the failure
   is edit-scoping, not pin integrity.

Baseline’s remix-specific classes did not reproduce: zero
one-shot-fork-modify-collisions (the gesture now owns the fork; all 9
gestures — 8 instruction-carrying plus the plain pill — succeeded), zero
fork-without-modification silent drops, zero
fork-instead-of-host-node (both no-silent-fork asks composed the host node or
failed loudly without forking), zero fork-props-clobber crashes (no node
props are minted; live wrapper props flow into the in-place fork).

## Findings (recorded, not fixed — this lane changes only docs/eval/**)

- **Base-prompt over-generation (staging).** On both hosts the fixed base
  prompt “a page with just a heading that says '…'” over-delivers a full
  dashboard (Maple’s even contained a MapleNetWorthCard host node before
  R-M4’s measured edit). Gesture scenarios are unaffected (the fork mints its
  own app), but it dirties the canvas the no-silent-fork scenarios edit.
- **The appId-less gesture still mints `placements:[slot]`** on the fork app
  (R-M1 appdoc: `placements:["NetWorthView"]`) — the known W1e cross-lane
  finding, W0 owns the mint.
- **Cosmetic literal drift on host-node composition** (R-C4/R-C5
  `badgeLabel:"Need chasing"`): optional style props get invented literals
  even when the data props bind honestly.
- **Frozen “now”** (R-C5): a generated island hardcodes the current date for
  relative-time labels instead of reading a clock.
- Harness notes: every wire mutation (including bodyless DELETE) requires
  `content-type: application/json` (the CSRF json-mutation gate); the jail
  nests two srcdoc frames — the fork’s DOM is in the inner one; the
  drift-notice state renders the wrapper zero-height to Playwright’s
  visibility check (wait on attachment). Two in-run harness fixes (not
  tuning, both staging-side): base-app selection had to skip the store’s
  re-seeded demo apps, and the DELETE content-type fix above — R-M2’s only
  pill-click attempt happened after it.
