# genbench

Answers "why not build this in-house?" with numbers.

It runs hand-written prompts through three contenders — the real Vendo pipeline
and two raw-Claude baselines — against one fictional banking product defined
entirely in JSON, scores what comes back with deterministic checks, and measures
time and money. Every contender gets the same model, the same tools, the same
schemas and the same design brief, because that equivalence is the whole claim.

## The contenders

| contender | what it is |
| --- | --- |
| `vendo` | the real product: the screen assembler, the guard, the apps runtime, the compiler and the Kit. Its artifact is a `.vendo` document, and the page is that document mounted through the product's own renderer |
| `diy` | the cheap in-house build: ONE `streamText` call, one HTML document, no product. Its artifact IS the page — no compile, no Kit, no mount |
| `claude-code` | the strong in-house build: the stock Claude Agent SDK with hands, writing and rewriting one `index.html` in a scratch directory. Its artifact IS the page too, and it is billed by its own session rather than by the run's meter |

All three are handed the same thing, and that is asserted rather than
asserted-to-be. There is exactly **one world serializer** — `worldBlock` in
`src/vendo.ts` — and both baselines send it. `tests/diy.test.ts` then compares the
prompt each baseline really put on the wire (the model `diy` streamed through,
the session `claude-code` opened) against the briefing pack the vendo driver
composes (`renderBriefingPack`), the descriptors its registry serves, and the
responses that registry really returns — byte for byte, for every baseline. If
any side drifts, the test fails and the comparison is void. It is the
benchmark's credibility, so it is the first test to read.

Every page then carries the SAME injected recorder (`seam` in `src/render.ts`)
and the SAME `@font-face` (`fontFace`, below), so `window.vendo.callTool` means
one thing whoever wrote the page, every column is shot in the world's own face,
and the same screenshot, the same click probe and the same floor code run after
that point. A contender told to write its own `window.vendo` — `claude-code` is,
so its file works opened straight off disk — has it **wrapped** rather than
overwritten: the feed half of the recorder is installed once the page has
loaded and delegates to whatever it finds, so every column's presses reach the
preview's live feed and the calls the floor scores are the contender's own
either way (`tests/seam.test.ts`).

Every contender for a case runs **at once**. They share the browser and nothing
else — a page each, a meter each, a clock each — and one contender's crash or
timeout is recorded as its own failure without touching its siblings. Column
order is the declaration order in `DRIVERS`, never the order they finished.

The case budget is **per contender** (`CASE_TIMEOUT_MS`), not one number for the
row: `vendo` and `diy` answer in one call and keep a five-minute bound, while
`claude-code` runs its own ten-minute wall clock inside the driver before it has
delivered anything, so its case gets twelve. A shared five-minute bound would
have ended that column early and reported a timeout the contender never had.

## Run it

```sh
pnpm build                                  # genbench reads the built @vendoai/* dists
ANTHROPIC_API_KEY=… pnpm genbench run --prompt spend-overview
```

Each case writes `runs/<run>/<contender>/<case>/`, where `<contender>` is the
column's slug — `<harness>-<model>`, e.g. `vendo-sonnet`, `diy-opus`,
`claude-code-haiku`:

| file | what it is |
| --- | --- |
| `artifact.vendo` | the document the contender actually saved (vendo only — a contender whose outcome says `format: "html"` has already delivered a document, and it lands once, as `page.html`) |
| `page.html` | the real screen: for vendo a root, the payload and the product's own renderer bundled in; for `diy` and `claude-code` the document each wrote. This is the only way pixels are made |
| `screenshot.png` | that page, shot once it has settled |
| `result.json` | the five floor verdicts and any check programs tier 2 executed, the judge's verdict for every rubric line and the contract it graded under, the click trace, console errors, timings, tokens and dollars |

and one `runs/<run>/preview.html`, which is where a person actually looks:

- **one section per case**, its prompt as the heading
- **a column per contender**, in a fixed order, each live and scrollable under
  its own verdicts and numbers, with the judge's screenshot demoted to a
  thumbnail
- **the rubric, line by line**, under each column: every correctness line then
  every design line, its verdict and the evidence the judge named, with a
  tally per half. A line the screen has no subject for is `na` and sits out of
  the denominator; a judge that could not grade says so instead of printing a
  tally that would read as the contender's score
- **the audit block**, on any column where tier 1 could not clear a value: the
  value, the check program that was executed for it and what that returned, so a
  number cleared by tier 2 can be re-checked by hand
- **the world-data panel** — collapsed: every tool the case's screens could
  call, what it does, and the exact response it answers with, overrides
  applied. It is what makes any number on any screen checkable by eye
- **the tool-call feed** — pinned to the bottom. Press anything in any embedded
  screen and the call it fired lands there, tagged with the contender whose
  frame fired it: `14:32:05 · diy-sonnet · cancel_transfer {id: tr_1}`. A
  control that fires nothing writes nothing, which is the same verdict the floor
  reaches

It stays one static file — no server, offline, forever. A contender that
outruns its budget is recorded `failure: "timeout"`; its siblings finish
normally.

Flags: `--prompt <id>` for one case, `--models sonnet,opus,haiku`,
`--world <name>` (default `maple`), `--lane build` (deferred).

A `--prompt` run opens the preview on macOS when it finishes — that is one
person watching one case, and a window is the point of it. A full run prints the
path instead, and `CI` or `GENBENCH_NO_OPEN=1` suppresses the window entirely.
The path is always printed either way.

### Exit code

The floor alone decides it: **any floor failure in any column exits 1**, and
nothing else does — a judge outage and a rubric line the judge failed both exit
0, loudly, in `result.json` and in the preview. The last line of every run says
which it was, in words:

    floor failures: 2 (exit 1)

Run through `pnpm`, a non-zero exit adds pnpm's own `ELIFECYCLE  Command failed
with exit code 1` after that line. That is pnpm reporting genbench's exit, not a
second failure.

### Time and money, in orders of magnitude

One case is roughly **1-4 minutes and $0.30-$0.50** of contender spend, plus the
judge. The full five-case screen run is 3-15x that. `--models` multiplies the
whole thing by the number of models, because the matrix is every harness in
every model.

Every dollar comes from the price table in `src/meter.ts`, **priced as of
2026-08-08**: Opus 5 at $5/$25 per MTok, Sonnet 5 at its introductory $2/$10
(through 2026-08-31, after which it returns to $3/$15), Haiku 4.5 at $1/$5. The
token counts beside every dollar are the durable number — the dollars are a
reading of that table on the day the run happened, so two runs' dollars only
compare if the table did not move between them.

## The world

A world is a **folder**, `worlds/<name>/`:

| file | what it is |
| --- | --- |
| `world.json` | the entire product: identity, a `VendoTheme`, a plain-English style rubric, and ~4 tools |
| `cases.json` | the prompts |
| `font.woff2` | optional. The face the theme's `fontFamily` names, injected into every contender's page |

`maple` is the only world today. A tool that declares `data` returns rows and is
graded `read`; one that only declares `takes` mutates and is graded `write`.
Input schemas are derived from `takes` (a name → type map), output schemas from
the example rows.

**Money is in integer cents**, as the Kit's `format="money"` and the demo host
both expect. This is load-bearing: a world authored in dollars lets a 100×
scale error slip past the fabrication check, which is exactly the bug the
regression test in `tests/floor.test.ts` pins down.

`cases.json` holds the prompts. A case may override any tool's data — that is
how the empty state is tested — and its `pass` lines are the correctness rubric
the judge grades.

Every `result.json` carries two comparability stamps and only compares with
another result when **both** match: `world` is the world folder's content hash,
and `caseHash` (`caseHash` in `src/world.ts`) is a digest of the case as
authored — its `prompt`, its `pass` lines and its `data` override. The case
stamp is per case on purpose, so editing one case declares that case's recorded
runs incomparable and leaves every other case's alone.

### The face

A world folder may ship `font.woff2`, and the harness declares it as an
`@font-face` under the family the theme names — the same `<style>` block, the
same bytes, in **every** contender's page (`fontFace` in `src/render.ts`, called
by both `pageHtml` and `authoredPage`). It rides as a data URL because the page
has no network, and `font-display: block` so a shot can never catch the fallback
mid-swap.

That is what makes the typography line of the style rubric gradeable from
pixels: a contender that asks for the theme's family now visibly gets it, and
one that invents its own visibly does not. The face is part of the world, so it
is hashed with `world.json` into `world.hash` — a run with a different face does
not compare with a run without it.

`maple` ships **Onest** (SIL OFL 1.1), the latin subset decoded out of the face
the product itself vendors in `packages/ui/src/chrome/onest-font.gen.ts`; the
license text is `packages/ui/ONEST-OFL.txt`.

## The floor

Five deterministic checks, no model involved:

- **delivered** — an artifact came back at all
- **renders** — the page mounted and took up space, with nothing on the console
- **valid** — the product's *own* checks floor blocks nothing in the saved bytes.
  Not the same as "something painted": the agent can save again after its last
  good view, and the seam keeps the older screen. A contender with no compile
  step has nothing to block, so for `diy` and `claude-code` this check collapses
  onto `delivered` — the checks that do the work on a hand-written page are `renders`,
  `honestData` and `wiredActions`, and all three are the same code
- **honestData** — every number and date on screen traces back to the tools, in
  two tiers. **Tier 1** is deterministic, runs first and decides most screens on
  its own: a contender may show any literal number or date a tool returned; the
  **row count** of one tool; the **sum, mean, min or max** of one numeric field
  across one tool's rows; and the **count of one tool's rows filtered to one
  field equalling one value** ("2 pending transfers" — two of `list_transfers`'
  four rows carry `status: "pending"`). Money is matched at either scale, because
  the same amount may be authored in cents and shown in dollars; a count is
  matched at its own magnitude only, since two transfers is never $0.02 or 200 of
  anything. Whatever tier 1 cannot clear goes to **tier 2**, below
- **wiredActions** — the probe pressed every control on the page and every call
  that fired names a real tool with schema-valid arguments. A control that fires
  nothing fails: naming a tool in a document is not being wired to it, which is
  the difference `tests/probe.test.ts` exists to keep honest

### Tier 2: only executed code clears a value

A closed allowlist cannot express every honest arithmetic a screen might do — a
percentage was the case that proved it. "Housing is 67.2% of my spending" is
derived from the data by any reasonable reading, and tier 1 has no rule that
reaches it, so it called an honest screen a liar. Widening the allowlist is how
that ends badly: every rule added to it is a rule a *fabricated* number can also
satisfy. So tier 2 moves the burden instead of relaxing it.

Values tier 1 could not clear go to a pinned auditor (`AUDITOR_CONTRACT` in
`src/audit.ts` — model, `auditVersion`, and a hash of its prompt, stamped the
same way the judge's is) along with the screen text around each value and the
case's tool data. It may **see** the data, and it may answer with only one thing:
a **check program**, the body of a JavaScript function over a `data` object
holding one entry per tool under exactly that tool's name — keyed rather than
one variable each, because `TOOL_NAME_PATTERN` permits names JavaScript cannot
bind (`report-total`). The harness runs that program in a `node:vm` sandbox — no imports, no
`require`, no I/O, no globals beyond the tools' own data, code generation off,
250 ms deadline — and compares what it returned against the number on screen
through the same normalisation tier 1 uses.

**Only that comparison clears a value. The auditor's prose is never read.**

- A program containing the value it is meant to derive — at any scale, in any
  notation, so `9999`, `9999.00` and `999900 / 100` all count — is rejected
  before it runs, and the attempt is spent. Writing the answer down proves
  nothing.
- **Two attempts** per value, then it stays an offender, `why: "no executable
  derivation found"`.
- **One call per round**, covering every value still unresolved at once, and
  **up to two rounds** — a value rejected in the first gets one retry before it
  stays an offender, so a screen with a hard value can cost two calls, not one.
  **No call at all** when tier 1 cleared everything, which is the common case,
  so most runs pay nothing for this.
- Auditor unreachable → its values stay offenders and `honestData.degraded` is
  true. Fail-closed, the same posture the judge takes.
- Dates are tier 1's alone: the comparison that clears a value is numeric, so
  there is nothing here that could execute against one.

Every audited value is recorded in `result.json` under `honestData.audited` —
the value, the program verbatim, what executing it returned, the verdict and the
attempt count — and shown in that column in the preview with its program on the
page. What auditing cost is its own line under the run header, priced through
the same table as everything else, and never added into a contender's `cost`.

## The judge

What the floor cannot settle: one verdict per rubric line — the case's `pass`
lines (did it do what was asked) and the world's `style` lines (does it look
like the product it claims to be) — from a pinned `claude-opus-5` that is shown
the screenshot, the click trace and the source.

It grades **blind**. Nothing it is sent names the contender, its model or its
run folder, and the lines arrive shuffled and are mapped back after. Every
verdict is `pass`, `fail` or `na`, and carries one clause naming the evidence it
was reached on. `na` means the line's subject is not on this screen at all, so
it is neither earned nor missed and sits out of the tally.

Grading is not free, and what it cost is reported **separately**: `judged.cost`
in each `result.json` (`{ usage, usd }`, priced through the same table as the
contenders) and one line under the run header in the preview. It is never added
into a contender's `cost`. A column's `cost` is what THAT contender spent to
build a screen — through the run's own meter, or for `claude-code` what its own
session reported — and folding the benchmark's overhead into it would make every
column look more expensive than the thing it measures.

The grader is pinned separately from the contenders (`JudgeContract` in
`src/judge.ts`: model, `rubricVersion`, and a hash of the system prompt) and
stamped into every `result.json`. Two runs' verdicts only compare if that stamp
matches — **any** edit to the prompt bumps `rubricVersion` and starts the
numbers again.

**A degraded judgement never fails the run.** The judge is a third party on
someone else's infrastructure; the floor is mechanical, local and cannot be
unwell, so the floor alone decides the exit code (`exitCode` in `src/run.ts`).
When the judge cannot be trusted it fails every line rather than guessing, says
so on the terminal, in `result.json` and at the top of its column in the
preview, and the run still exits on what the floor found. A column that
delivered no screen at all is failed on every line too, but that is the
contender's failure and is not marked degraded.

## What honestData does not read

Two things are cut out of the text the fabrication check grades, both of them
things a chart writes to measure with rather than to say. The cut is made in the
browser, by hiding the containers before extraction and restoring them before
the screenshot, so the *picture* is untouched. Extraction itself walks every
visible text node under `document.body` with a `TreeWalker`, joining text from
the same element as written and inserting a space at every element boundary —
not `document.body.innerText`, which collapses adjacent inline boxes together
and would fuse a row's amount into its neighboring percentage:

- **`.recharts-cartesian-axis-tick-labels`** — the scale. A chart of the
  spending case draws `$0.00 / $750.00 / $1,500.00 / $2,250.00 / $3,000.00` down
  its axis, and not one of those is a value any tool returned. Graded, every
  honest chart fails; ungraded, the check keeps its meaning everywhere else.
- **`#recharts_measurement_span`** — an offscreen scratch pad at `top:-20000px`
  holding the last string recharts sized. No human has ever seen it, and
  `innerText` reports it anyway.

**The cost, stated plainly:** the exclusion is a whole tick layer, so the
category axis goes with the scale. A number or date that appears **only** on a
chart axis and nowhere else on the screen is therefore not graded. Everything
else still is — a fabricated number in the screen's own copy fails exactly as
before. `tests/axis.test.ts` pins both halves in a real browser: it proves the
labels really are in the page's own text, really would fail, are gone from the
extraction, and that the screen's own copy is still caught. It fails loudly if
recharts ever moves that text.

One consequence follows from the same exclusion: a screen whose only text IS
excluded chart scaffolding — a chart and nothing else, no caption, no label in
the screen's own copy — passes `honestData` unexamined, not because it was
checked and cleared but because there was nothing left to check. `examined` in
`HonestDataResult` is how a reader tells the two apart: a real pass carries the
count of values it cleared, and a vacuous one carries `0`.

## Tests

`pnpm --filter @vendoai/genbench test`. `vitest.config.ts` caps the pool at 1-2
workers and drops the five browser suites when `CI` is set, because CI installs
no Playwright browsers.

Two tests spend real money, and both are gated twice — they need
`GENBENCH_LIVE=1` **and** `ANTHROPIC_API_KEY`, so neither CI nor a stray
`vitest` run can trigger them: the judge's live smoke test (`tests/judge.test.ts`)
and the Claude Code driver's (`tests/claude-code.test.ts`).

## Known limits

Shipping the face changed `world.hash`, so runs from before this slice do not
compare with runs after it. Unifying the two baselines onto one serializer
changed the `diy` prompt's wording too, which is the same story: the numbers
start again here.

The probe presses one control per fresh page, so a screen with many controls
costs many reloads. Multi-step flows are only followed one step past a
`[role=dialog]` confirmation.
