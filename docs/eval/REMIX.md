# REMIX — the frozen Vendo remix/fork eval

Status: FROZEN 2026-07-20 (authored blind, before any run). This is the golden
set for the REMIX feature: remixable host slots, `<ForkPin>`, pin preservation,
ship-diff, and drift→rebase. Same doctrine as [`GOLDEN.md`](./GOLDEN.md): frozen
scenarios no fix is ever tuned against, run ONCE per wave through the real
engine on real hosts in a real browser, judged against the written PASS bar
with committed screenshots.

Baseline at freeze: see the run ledger at the bottom (first run lands in
`docs/eval/runs/2026-07-21-remix-baseline/`).

## Rules — read before running

1. **FROZEN. Never tuned against.** No scenario here ever guides a code change,
   prompt edit, or schema tweak. Fails are the data.
2. **Run ONCE per wave.** One full pass over the 12 scenarios, one attempt per
   measured instruction, with timing and a verdict per scenario.
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

## What remix is (for the judge)

Hosts mark components as remixable slots; `vendo sync` captures their source
hash-pinned into `.vendo/remixable/`. At EDIT time the model emits
`<ForkPin slot="..."/>`; the ENGINE copies the trusted captured source into a
named generated component (`Pinned<Slot><hash8>`) and records the pin
`{slot, base}`. Later edits re-declare that component while preserving the pin.
`GET /apps/:id/ship-diff` shows the reviewable delta vs the captured baseline;
`pin-drift`/`rebase-pin` handle the host updating their component (rebase
re-forks from the new baseline and replays recorded pin intents; it is never
automatic). Design fact encoded by this eval: `ForkPin` is an **edit-dialect**
extension op — the create contract does not carry the remixable-slots section,
so every remix journey is an edit on an existing app.

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
8. **No-fork discipline.** When the host component already covers the ask
   verbatim, the engine uses the host catalog component (bound to real data, or
   honestly handled where no tool supplies a prop) — no pin appears, and no
   rewritten island imitation of the host component appears. A gratuitous fork
   or a hand-rolled lookalike is a FAIL.
9. **Drift honesty (R-M6 only).** After the host source changes under a fork:
   the reopened app surfaces the drift notice; `pin-drift` reports the slot
   with the right reason; ship-diff marks the pin `drifted`. Rebase happens
   ONLY on explicit invocation, lands the fork on the new baseline hash,
   replays the recorded pin intents, and clears the drift notice. Any silent
   auto-rebase, or a rebase that loses the user's modification without saying
   so, is a FAIL (a `failed` rebase report that persists nothing and says which
   intent failed is honest-by-construction and judged on its honesty).

Record timing (submit → updated app visible) for every measured instruction.
Category tags: `[fork-modify] [fork-then-edit] [no-fork] [pin-preserve]
[empty-delta] [honesty] [drift]`.

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
  render, recreate it (noted); scenario verdicts start at the first remix
  instruction.
- **Edit surface**: Maple edits go through the `/vendo/apps` page's edit box
  (the real `POST /apps/:id/edit` path). Cadence's shipped `VendoPage` has no
  edit input, so Cadence edits invoke the SAME wire call from the page context
  (`client.apps.edit` via in-page fetch with credentials) and are then judged
  on the reopened rendered app. Ship-diff is judged in Maple's Ship review
  panel; on Cadence via the wire response rendered from the same session.
- **Drift staging (R-M6)**: after step A, apply a minimal visible change to the
  host component source (label text in `net-worth-view.tsx`), run `vendo sync`
  to recapture, restart the host, run steps B–C, then REVERT the source change,
  re-sync, and verify the baseline hash returns to its original value. The
  staging edit is scenario apparatus, never left in the tree.
- One attempt per measured instruction; a second attempt only for pure
  infrastructure failure (host down, browser crash), noted in the row.
- Kill all host and browser processes when done; verify no orphaned `next`
  builds remain.

## The 12 frozen scenarios

Steps marked (A), (B), (C) are measured instructions in order, each issued as
one edit on the scenario's fresh base app.

### demo-bank (Maple) — R-M1–R-M6

- **R-M1** [fork-modify] — (A) `remix the bank's net worth card to also show
  the change in dollars for the selected range under the big number`.
  Expect: pin recorded for MapleNetWorthCard; fork faithful; a $-change line
  added below the headline, derived from the series the card already carries
  (no invented figures); ship-diff = that addition only.
- **R-M2** [empty-delta][fork-then-edit] — (A) `I want my own copy of the
  bank's net worth card here so I can tweak it later` — expect an UNEDITED
  fork: pin recorded, fork pixel-faithful, ship-diff delta EMPTY.
  (B) `make the change badge blue instead of green` — expect a delta touching
  only the badge colors; pin preserved; everything else untouched.
- **R-M3** [fork-then-edit] — (A) `remix the net worth card so the range
  switcher only offers 1M and 1Y`. (B) `add a small caption under the chart
  that says 'Excludes pending transactions'`. Expect: both modifications
  present after (B), original behavior otherwise intact (1M/1Y still switch),
  pin preserved through the chain, ship-diff = exactly the two changes.
- **R-M4** [no-fork] — (A) `add the bank's net worth card to this page,
  exactly as it is`. Expect: a `source:"host"` MapleNetWorthCard node — NO
  ForkPin, no pin in ship-diff, no lookalike island; props bound from host
  tools where a tool supplies them, honest handling where none does.
- **R-M5** [pin-preserve] — (A) `remix the net worth card so the title says
  'Savings power' instead of 'Total balance'`. (B) `add a table of my accounts
  with their balances below the card`. Expect: (B) leaves the fork
  byte-identical (pin diff unchanged between shots), pin still listed, table
  added outside the fork bound to real account data.
- **R-M6** [drift] — (A) `remix the net worth card so the default range is
  1Y`. STAGE host change + re-sync + restart (protocol above). (B) reopen the
  app — expect the drift notice ("The host updated ... Ask the agent to rebase
  ..."), `pin-drift` reporting `baseline-changed`, ship-diff `drifted`.
  (C) invoke the explicit rebase for the slot — expect `status:"rebased"` with
  the (A) intent replayed, the reopened fork showing BOTH the host's new label
  and the 1Y default, and the drift notice gone.

### demo-accounting (Cadence) — R-C1–R-C6

- **R-C1** [fork-modify] — (A) `remix the missing-documents hero to also show
  what percent of clients are fully complete`. Expect: pin recorded for
  CadenceMissingDocsHero; fork faithful; a percent derived from the counts the
  hero already carries; ship-diff = that addition only.
- **R-C2** [fork-modify][honesty] — (A) `remix the missing documents hero to
  show the week-over-week change in clients missing documents`. Cadence has no
  historical/week-over-week tool: expect a faithful fork whose added region
  handles the ask HONESTLY (omitted or labeled unavailable). A fabricated
  last-week number or delta inside the fork is a FAIL.
- **R-C3** [fork-then-edit] — (A) `make me a version of the missing docs hero
  with the badge saying 'Chase these'`. (B) `make the big number amber when
  more than half of active clients are missing documents`. Expect: both
  changes, conditional color driven by the hero's own counts, pin preserved,
  minimal two-change delta.
- **R-C4** [no-fork] — (A) `add the missing documents hero card to this page
  as-is`. Expect: `source:"host"` CadenceMissingDocsHero node bound to real
  client/document counts from host tools — no pin, no imitation island.
- **R-C5** [no-fork] — (A) `a section with the missing documents hero on top
  and a table of clients with outstanding documents below it`. Expect: hero as
  an unmodified host node (no ForkPin — nothing about the hero is being
  changed), table composed outside it from real data. A gratuitous fork is a
  FAIL.
- **R-C6** [pin-preserve] — (A) `remix the missing docs hero so the label
  reads 'Clients still owing documents'`. (B) `add a donut of documents by
  status next to it`. Expect: (B) leaves the fork byte-identical, pin intact,
  donut added outside the fork from real document data.

## DEV list — burned scenarios

(empty at freeze — rule 4 populates this)

## Run ledger

| Date | Set | Score | Main @ | Evidence |
|---|---|---|---|---|
