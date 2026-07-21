# REMIX — the frozen Vendo remix/fork eval

Status: FROZEN 2026-07-20 (authored blind, before any run). RESTATED 2026-07-21
gesture-first after Yousef's redesign ruling (see "Design rulings" below): the
scenario ASKS and the PASS bar are unchanged in substance, but forking is now a
user gesture the engine executes deterministically, so fork scenarios are
invoked through the gesture surface and the "should it fork?" scenarios measure
no-silent-fork discipline. This is the golden set for the REMIX feature:
remixable host slots, gesture forks, pin preservation, ship-diff, and
drift→rebase. Same doctrine as [`GOLDEN.md`](./GOLDEN.md): frozen scenarios no
fix is ever tuned against, run ONCE per wave through the real engine on real
hosts in a real browser, judged against the written PASS bar with committed
screenshots.

Baseline at freeze: see the run ledger at the bottom (first run lands in
`docs/eval/runs/2026-07-21-remix-baseline/`).

## Rules — read before running

1. **FROZEN. Never tuned against.** No scenario here ever guides a code change,
   prompt edit, or schema tweak. Fails are the data.
2. **Run ONCE per wave.** One full pass over the 12 scenarios, one attempt per
   measured step, with timing and a verdict per scenario.
3. **Browser-judged with screenshots.** Every measured step is driven through
   the real Apps surface in a real browser; verdicts come from reading the
   rendered fork against the PASS bar, with committed screenshots (fork render,
   before/after for edit chains, and the ship-diff view where the scenario
   checks it).
4. **A discussed scenario is burned.** Any scenario named, quoted, or analyzed
   in a fix PR moves to a DEV list and is replaced blind before the next run.
5. **Metric = scenario-level PASS rate over the 12.** A scenario passes only
   when every one of its measured steps meets the bar. Base-app staging steps
   (see protocol) are not judged and may be retried on infra failure only.

## Design rulings (2026-07-21, Yousef) — what the restatement encodes

- **Gesture-owned forking.** The fork executes DETERMINISTICALLY when the user
  acts on a remixable slot (the slot's Remix affordance; on the wire,
  `POST /apps/:id/fork-pin { slot, instruction? }`): the ENGINE copies the
  captured source and records the pin — no model call for the fork itself. An
  instruction riding the gesture reaches the model ALREADY SCOPED as an
  ordinary island edit on the existing fork. `<ForkPin>` is retired from the
  model's edit dialect (the op still compiles for stored apps). Text never
  silently forks: text-triggered remixing becomes a confirmation affordance
  (surfaced for a tap) — future UX, measured by the no-silent-fork scenarios.
- **Honesty beats MUST-use-host (the F4 ruling).** When a host catalog
  component's REQUIRED data props cannot be truthfully bound from any tool, it
  "doesn't fit" and the must-use-host rule does not apply (law 1: never invent
  numbers). Checked against the two hosts' tool inventories and the binding
  grammar (one tool call plus a plain field path — no arithmetic, no
  aggregation), the premise splits by host: the Maple slot's
  `valueCents`+`series` bind from NO tool (there is no balance-history
  endpoint, and a total would need summing account balances), so the honest
  "add the card" surface there is the sample-seeded FORK the gesture produces
  and a host node with invented props is the FAIL. The Cadence slot's
  `missingCount`+`clientCount` DO bind truthfully — `getDashboard` returns
  `data.clientsMissingDocs`/`data.clientsTotal`, the very fields the host's
  own page passes in — so must-use-host APPLIES on Cadence: the tool-bound
  host node is the covered answer, and invented or frozen literals are the
  FAIL.

## What remix is (for the judge)

Hosts mark components as remixable slots; `vendo sync` captures their source
hash-pinned into `.vendo/remixable/`. The user FORKS a slot by gesture: the
ENGINE deterministically copies the trusted captured source into a named
generated component (`Pinned<Slot><hash8>`) and records the pin `{slot, base}`
— the model never decides to fork and never retypes the source. An instruction
carried by the gesture runs afterwards as ONE ordinary edit, already scoped to
the forked component; later edits re-declare that component while preserving
the pin. `GET /apps/:id/ship-diff` shows the reviewable delta vs the captured
baseline; `pin-drift`/`rebase-pin` handle the host updating their component
(rebase re-forks from the new baseline and replays recorded pin intents; it is
never automatic).

The two captured slots (one per demo host):

- **Maple** `MapleNetWorthCard` — animated USD total, change badge, 1W/1M/3M/1Y/All
  range switcher, SVG area trend. Also a host CATALOG component with a props
  schema (`valueCents`, `series`, `changeLabel`, `initialRange`, `chartHeight`).
- **Cadence** `CadenceMissingDocsHero` — dashboard hero number (clients missing
  documents), action badge, active-client total. Also a host CATALOG component
  (`missingCount`, `clientCount`, `badgeLabel`).

## PASS bar (judge each scenario honestly)

A remix scenario PASSES only when ALL of these hold for its measured steps:

1. **Fork faithfulness.** The forked slot renders visually faithful to the host
   original — same layout, typography, brand colors, spacing, and interactive
   behavior (e.g. the range switcher still switches) — judged against the live
   host page's own render of the component. A fork that renders blank, broken,
   or as an off-brand approximation is a FAIL.
2. **Requested modification only.** The asked-for change is applied, and ONLY
   that: no drive-by redesigns, no dropped features of the original, no
   unrelated content appearing inside the fork.
3. **Pin integrity.** The app records the pin for the slot (`{slot, base}`),
   and the pin survives every subsequent edit in the scenario: ship-diff keeps
   listing the component under "Forked host slot" (never demoted to a plain
   generated component), and the pin is never dropped or duplicated.
4. **Ship-diff honesty.** The pin's diff vs the captured baseline is an honest,
   minimal, reviewable delta: it contains the requested change(s) and nothing
   unrelated — no wholesale rewrite, no reformat/reindent noise drowning the
   change. An unedited fork reads as an EMPTY delta.
5. **No runtime errors.** No error box or error blob, no blank iframe region,
   no dead placeholder where the fork should be.
6. **Data honesty in the fork.** Every figure the fork renders comes from bound
   host data or the captured sample seed — never invented. When the ask needs
   data no host tool provides, the fork handles it honestly (omits the region
   or says so); a fabricated number inside a fork is a FAIL.
7. **Brand fidelity.** The modified fork still reads as host-native — the
   modification adopts the host's tokens, not a foreign style.
8. **No-silent-fork discipline (F4-ruled).** TEXT never forks: a typed
   instruction — however remix-shaped — must not mint a pin on its own (a
   confirmation affordance for a tap is the sanctioned future UX). And when a
   typed ask names a host component: use the host catalog node ONLY where its
   required props bind truthfully from tools; where they cannot (the Maple
   slot — the Cadence hero binds from `getDashboard`, see the F4 ruling),
   honest handling wins — an honest empty-state/omission, or pointing
   the user at the Remix gesture. A hand-rolled lookalike island or a host
   node with invented props is a FAIL. (A gesture fork with no instruction is
   the CORRECT "add the card as-is" surface and expects an EMPTY delta.)
9. **Drift honesty (R-M6 only).** After the host source changes under a fork:
   the reopened app surfaces the drift notice; `pin-drift` reports the slot
   with the right reason; ship-diff marks the pin `drifted`. Rebase happens
   ONLY on explicit invocation, lands the fork on the new baseline hash,
   replays the recorded pin intents, and clears the drift notice. Any silent
   auto-rebase, or a rebase that loses the user's modification without saying
   so, is a FAIL (a `failed` rebase report that persists nothing and says which
   intent failed is honest-by-construction and judged on its honesty).

Record timing (submit → updated app visible) for every measured step — for a
gesture, wire-call submit → updated app visible. Category tags: `[gesture-fork]
[fork-modify] [fork-then-edit] [no-silent-fork] [pin-preserve] [empty-delta]
[honesty] [drift]`.

## Run protocol

- Real engine, production hosts (`next build && next start` — NEVER `next
  dev`), one host booted at a time, dedicated headless Playwright instance
  (never the shared MCP browser). Boot recipes: the gate TASK files
  (`docs/verification/final-gate/TASK-MAPLE.md`, `TASK-CADENCE.md`).
- **Reference shots first**: screenshot the host's own render of the slot
  (Maple home net-worth card; Cadence dashboard hero) — the fidelity baseline
  for bar item 1.
- **Base app rule**: every scenario starts from a FRESH app created with the
  host's fixed base prompt — Maple: `a page with just a heading that says 'My
  corner'`; Cadence: `a page with just a heading that says 'Week ahead'`. The
  base create is staging, not a measured step: if the base itself fails to
  render, recreate it (noted); scenario verdicts start at the first measured
  step.
- **Gesture surface**: a fork gesture is `POST /apps/:id/fork-pin
  { slot, instruction? }` invoked from the page context with the session's
  credentials — the same wire call the slot's Remix affordance makes. The
  gesture (deterministic fork + optional scoped edit) is ONE measured step.
- **Edit surface** (for text steps): Maple edits go through the `/vendo/apps`
  page's edit box (the real `POST /apps/:id/edit` path). Cadence's shipped
  `VendoPage` has no edit input, so Cadence edits invoke the SAME wire call
  from the page context (`client.apps.edit` via in-page fetch with
  credentials) and are then judged on the reopened rendered app. Ship-diff is
  judged in Maple's Ship review panel; on Cadence via the wire response
  rendered from the same session.
- **Drift staging (R-M6)**: after step A, apply a minimal visible change to the
  host component source (label text in `net-worth-view.tsx`), run `vendo sync`
  to recapture, restart the host, run steps B–C, then REVERT the source change,
  re-sync, and verify the baseline hash returns to its original value. The
  staging edit is scenario apparatus, never left in the tree.
- One attempt per measured step; a second attempt only for pure
  infrastructure failure (host down, browser crash), noted in the row.
- Kill all host and browser processes when done; verify no orphaned `next`
  builds remain.

## The 12 frozen scenarios (restated gesture-first, 2026-07-21)

Measured steps are (A), (B), (C) in order on the scenario's fresh base app.
"Remix gesture on `<slot>` with «instruction»" = one `fork-pin` wire call
carrying that instruction; with no instruction it is the plain add-as-is
gesture.

### demo-bank (Maple) — R-M1–R-M6

- **R-M1** [gesture-fork][fork-modify] — (A) Remix gesture on
  `MapleNetWorthCard` with «also show the change in dollars for the selected
  range under the big number». Expect: pin recorded; fork faithful; a $-change
  line added below the headline, derived from the series the card already
  carries (no invented figures); ship-diff = that addition only.
- **R-M2** [gesture-fork][empty-delta][fork-then-edit] — (A) plain Remix
  gesture on `MapleNetWorthCard` (no instruction — "I want my own copy to
  tweak later") — expect an UNEDITED fork: pin recorded, fork pixel-faithful,
  ship-diff delta EMPTY. (B) text edit `make the change badge blue instead of
  green` — expect a delta touching only the badge colors; pin preserved;
  everything else untouched.
- **R-M3** [gesture-fork][fork-then-edit] — (A) Remix gesture with «make the
  range switcher only offer 1M and 1Y». (B) text edit `add a small caption
  under the chart that says 'Excludes pending transactions'`. Expect: both
  modifications present after (B), original behavior otherwise intact (1M/1Y
  still switch), pin preserved through the chain, ship-diff = exactly the two
  changes.
- **R-M4** [no-silent-fork][honesty] — (A) TEXT edit `add the bank's net worth
  card to this page, exactly as it is`. Expect: NO pin minted by text (text
  never forks). Honest handling per the F4 ruling: the catalog node's required
  data props (`valueCents`, `series`) bind from no tool, so a host node with
  invented props is a FAIL and so is a lookalike island — the edit passes by
  handling the ask honestly (an honest empty-state/note, or pointing at the
  Remix affordance; once the confirmation UX exists, surfacing it satisfies
  this scenario).
- **R-M5** [gesture-fork][pin-preserve] — (A) Remix gesture with «make the
  title say 'Savings power' instead of 'Total balance'». (B) text edit `add a
  table of my accounts with their balances below the card`. Expect: (B) leaves
  the fork byte-identical (pin diff unchanged between shots), pin still
  listed, table added outside the fork bound to real account data.
- **R-M6** [gesture-fork][drift] — (A) Remix gesture with «make the default
  range 1Y». STAGE host change + re-sync + restart (protocol above). (B)
  reopen the app — expect the drift notice ("The host updated ... Ask the
  agent to rebase ..."), `pin-drift` reporting `baseline-changed`, ship-diff
  `drifted`. (C) invoke the explicit rebase for the slot — expect
  `status:"rebased"` with the (A) intent replayed, the reopened fork showing
  BOTH the host's new label and the 1Y default, and the drift notice gone.

### demo-accounting (Cadence) — R-C1–R-C6

- **R-C1** [gesture-fork][fork-modify] — (A) Remix gesture on
  `CadenceMissingDocsHero` with «also show what percent of clients are fully
  complete». Expect: pin recorded; fork faithful; a percent derived from the
  counts the hero already carries; ship-diff = that addition only.
- **R-C2** [gesture-fork][fork-modify][honesty] — (A) Remix gesture with «show
  the week-over-week change in clients missing documents». Cadence has no
  historical/week-over-week tool: expect a faithful fork whose added region
  handles the ask HONESTLY (omitted or labeled unavailable). A fabricated
  last-week number or delta inside the fork is a FAIL.
- **R-C3** [gesture-fork][fork-then-edit] — (A) Remix gesture with «make the
  badge say 'Chase these'». (B) text edit `make the big number amber when more
  than half of active clients are missing documents`. Expect: both changes,
  conditional color driven by the hero's own counts, pin preserved, minimal
  two-change delta.
- **R-C4** [no-silent-fork][honesty] — (A) TEXT edit `add the missing
  documents hero card to this page as-is`. Expect: NO pin minted by text; per
  the F4 ruling the host node FITS here — `missingCount`/`clientCount` bind
  truthfully from `getDashboard` (`data.clientsMissingDocs`/`data.clientsTotal`)
  — so the PASS is the host catalog node with tool-bound props. Invented or
  frozen literal props, an imitation island, or a silently minted pin are
  FAILs.
- **R-C5** [no-silent-fork] — (A) TEXT edit `a section with the missing
  documents hero on top and a table of clients with outstanding documents
  below it`. Expect: no pin (text never forks; nothing about the hero is being
  changed), the hero rendered as the host catalog node with tool-bound props
  per the F4 ruling (no invented literals, no lookalike), and the table
  composed from real data. A silently minted pin or fabricated hero numbers
  are FAILs.
- **R-C6** [gesture-fork][pin-preserve] — (A) Remix gesture with «make the
  label read 'Clients still owing documents'». (B) text edit `add a donut of
  documents by status next to it`. Expect: (B) leaves the fork byte-identical,
  pin intact, donut added outside the fork from real document data.

## DEV list — burned scenarios

(empty at freeze — rule 4 populates this. The 2026-07-21 gesture-first
restatement is eval maintenance under the design rulings above, not a fix-PR
discussion; the asks and bar substance are unchanged, so the set stays live.)

## Run ledger

| Date | Set | Score | Main @ | Evidence |
|---|---|---|---|---|
| 2026-07-21 | frozen 12 (baseline, pre-restatement) | **2/12** | 4cb6cdb6 | `docs/eval/runs/2026-07-21-remix-baseline/` |

Baseline headline (pre-redesign semantics): the drift→rebase machinery is
solid end-to-end, but the headline "remix X so that Y" journey failed 6/8
times it was asked — 4× the engine rejected the model's one-patch
ForkPin+Island (component-already-exists), 2× the model forked without the
modification and reported success. Fork-then-edit chains were the only shape
that passed. Full classes + machinery findings in the run README. The
2026-07-21 redesign (gesture-owned forking; fork decision removed from the
model) restates the set above; the next run scores the restated semantics
after the parallel generation-prompt rewrite also lands.
