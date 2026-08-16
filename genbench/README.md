# genbench

Answers "why not build this in-house?" with numbers.

It runs hand-written prompts through three contenders — the real Vendo pipeline
and two raw-Claude baselines — against fourteen fictional products defined
entirely in JSON, scores what comes back, and measures time and money. Every contender
gets the same model, the same tools, the same schemas, the same design brief and
the same harness contract, because that equivalence is the whole claim.

## The contenders

| contender | what it is |
| --- | --- |
| `vendo` | the real product: the screen assembler, the guard, the apps runtime, the compiler and the Kit. Its artifact is the TSX screen it saved (`artifact.tsx`), and the page is that screen's compiled payload mounted through the product's own renderer |
| `diy` | the cheap in-house build: ONE `streamText` call, one HTML document, no product. Its artifact IS the page — no compile, no Kit, no mount |
| `claude-code` | the strong in-house build: the stock Claude Agent SDK with its stock loadout — Bash included — writing and rewriting one `index.html` in a scratch directory. What is taken away is isolation and not capability: the operator's own settings, MCP config and shell environment stay out, because a laptop's private tooling would silently become this column's advantage. Its artifact IS the page too, and it is billed by its own session rather than by the run's meter |

All three are handed the same thing, and that is asserted rather than
asserted-to-be. There are exactly **two shared texts** — `worldBlock` in
`src/vendo.ts`, the world every contender is briefed on, and `HARNESS_CONTRACT`
in `src/render.ts`, the mechanical seam every page-writing contender must satisfy
— and both baselines send both. `tests/diy.test.ts` then compares the prompt each
baseline really put on the wire (the model `diy` streamed through, the session
`claude-code` opened) against the briefing pack the vendo driver composes
(`renderBriefingPack`), the descriptors its registry serves, and the responses
that registry really returns — byte for byte, for every baseline. It also fences
the DIFF: whatever is left in a baseline's prompt after those shared blocks must
say nothing about `window.vendo`, the settle signal, confirmations, the viewport
or the network. `claude-code` was once coached on all five while `diy` was told
none of them, which grades the coaching rather than the screen. If any side
drifts, the test fails and the comparison is void. It is the benchmark's
credibility, so it is the first test to read.

The vendo column needs no such contract and is not given one: the product itself
wires `window.vendo.callTool` and `window.__settled` through `mount.tsx`, applies
the theme through `applyThemeVars`, and hands its writer the shipped
`building-apps` skill and format reference — which is where that column's
equivalent guidance (how a screen calls a tool, when to confirm) already lives.

Every page then carries the SAME injected recorder (`seam` in `src/render.ts`)
and the SAME `@font-face` (`fontFace`, below), so `window.vendo.callTool` means
one thing whoever wrote the page, every column is shot in the world's own face,
and the same screenshot, the same click probe and the same floor code run after
that point. A page that defines its own `window.vendo` anyway has it **wrapped**
rather than overwritten: the feed half of the recorder is installed once the page
has loaded and delegates to whatever it finds, so every column's presses reach
the preview's live feed and the calls the floor scores are the contender's own
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
| `artifact.tsx` | the screen the contender actually saved — TSX bytes, hence the extension (vendo only — a contender whose outcome says `format: "html"` has already delivered a document, and it lands once, as `page.html`) |
| `page.html` | the real screen: for vendo a root, the payload and the product's own renderer bundled in; for `diy` and `claude-code` the document each wrote. This is the only way pixels are made |
| `screenshot.png` | that page, shot once it has settled — the **viewport**, 480x900, which is the frame the harness contract promises and the only one the judge is shown |
| `result.json` | the five floor verdicts, what settled every value on the screen (the tools' own text, a triage waiver and its reason, or the program that was executed), the judge's verdict for every rubric line, the three contracts the run graded under — judge, triage, auditor — the commit the harness ran at and the Agent SDK version, the click trace, console errors, timings, tokens and dollars |

one `runs/<run>/summary.json` — the run's only aggregate, per column: floor cells
earned, failed, vacuous and degraded; rubric case-lines and style-lines by
verdict; timeouts; degraded judgements; total tokens and dollars; and the
gitSha, model ids and contract versions the numbers were produced under. One
honest JSON, no CSV and no charts.

And one `runs/<run>/preview.html`, which is where a person actually looks:

- **one section per case**, its prompt as the heading
- **a column per contender**, in a fixed order, each live and scrollable under
  its own verdicts and numbers, with the judge's screenshot demoted to a
  thumbnail
- **the rubric, line by line**, under each column: every correctness line then
  every design line, its verdict and the evidence the judge named, with a
  tally per half. A DESIGN line the screen has no subject for is `na` and sits
  out of the denominator; a correctness line is what the case asked for, so an
  `na` on one scores as a fail rather than shrinking the total; a judge that
  could not grade says so instead of printing a tally that would read as the
  contender's score
- **the honesty block**, on any column where a number needed settling: one row
  per value, saying which stage settled it — the tools answer with those exact
  characters, the triage waived it (in the model's own clause), or a program was
  executed, with the program on the page and what it returned. Every waiver is
  there to be overturned by eye
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
`--world <name>` (default `maple`) or `--world all` for every world in one run
folder — which is the only way to get one number for the whole corpus.

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
judge and the honesty check. A world is **ten or fifteen cases**, so one world's
run is roughly 10-15x that; `--world all` is **200 cases**, and nobody runs that
casually. `--models` multiplies the whole thing again by the number of models,
because the matrix is every harness in every model.

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

There are **fourteen worlds** — `maple` (consumer banking) plus thirteen more,
from build logs to trades accounting — carrying **fifteen cases** each, except
`buildlog` and `fieldops` at ten, so the whole corpus is **200 cases**. A tool
that declares `data` returns rows and is graded
`read`; one that only declares `takes` mutates and is graded `write`. Input
schemas are derived from `takes` (a name → type map), output schemas from the
example rows.

**Money is in integer cents**, as the Kit's `format="money"` and the demo host
both expect. This is load-bearing: a world authored in dollars lets a 100×
scale error slip past the fabrication check. `tests/worlds.test.ts` lints every
folder for it — and for empty reads, argument-less writes, dangling row ids,
untagged cases and overrides naming fields no tool has — at collection time, so
a world added tomorrow is linted the day it lands.

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

Five checks. **Four are deterministic** and no model touches them; the fifth,
`honestData`, is deterministic in what it CONVICTS and leans on a model twice —
once to decide which tokens are claims at all, once to write arithmetic the
harness itself runs. Neither model can clear a number on its own word:

- **delivered** — an artifact came back at all
- **renders** — the page mounted and took up space, with nothing on the console
- **valid** — the product's *own* checks floor blocks nothing in the saved bytes.
  Not the same as "something painted": the agent can save again after its last
  good view, and the seam keeps the older screen. A contender with no compile
  step has nothing to block, so for `diy` and `claude-code` this check collapses
  onto `delivered` — the checks that do the work on a hand-written page are `renders`,
  `honestData` and `wiredActions`, and all three are the same code
- **honestData** — every number on screen traces back to the tools, in three
  stages, each of which only ever takes work off the next one. See below
- **wiredActions** — the probe pressed every control on the page and every call
  that fired names a real tool with schema-valid arguments. A control that fires
  nothing fails: naming a tool in a document is not being wired to it, which is
  the difference `tests/probe.test.ts` exists to keep honest. A case tagged
  `action` has to show one press that really called a tool: a screen asked to DO
  something and proven by zero tool calls is not proven. `pressed` records how
  many controls there were to press, so a screen that passed with none is
  distinguishable from one whose controls all held — the same distinction
  `honestData.examined` draws, and the preview prints both

A pass on the last two is not always a pass. A screen with no numbers on it and
nothing to press clears both **vacuously**, and an honesty check whose triage or
auditor could not be reached is **degraded** — neither was earned and neither was
missed, so both stay out of the run's totals (`checks` in `src/floor.ts`, which
is what the shape table and `summary.json` both add up) and are counted beside
them instead. Summing bare booleans is how a blank page came to score 5/5 in the
only aggregate this benchmark had.

### honestData: what settles a number

The extraction is deliberately blind. It cuts every digit group out of the
screen's text and clears nothing on a rule, because a rule for what "looks like
data" is a rule a fabricated number can be written to satisfy — a closed
allowlist of literals, sums, counts, min, max and mean was exactly that, and a
percentage broke it: "housing is 67.2% of my spending" is honest by any
reasonable reading and no rule in the list reached it.

So three stages settle a token, cheapest first.

**1. The tools' own text.** A token that appears character for character as a
string value in the case's tool data is cleared on the spot, with no model and no
call: `J-2444` on a job card IS the id in the row, and an account mask is the
mask. Nothing to decide, nothing to compute. Strings only — a number the data
holds as a number may be shown at either money scale, and rescaling is arithmetic
that belongs to stage 3. Recorded as `cleared-by-verbatim`.

**2. Triage — which of the rest are claims.** Whatever survives goes, with the
screen text around it, to a pinned model (`TriageContract` in `src/triage.ts` —
model, `triageVersion` and a hash of its prompt, stamped into `result.json` the
same way the judge's is). It answers one word per token — claim or not — and one
clause of reason: a total is a claim, an hour on a clock, a duration, an ordinal,
a step number and a chart tick are not. It can only ever WAIVE; anything it does
not explicitly waive, with a reason, goes to stage 3, and an unsure triage is
told to check. Every decision it makes — waived and checked alike, in its own
words — is written to `result.json` under `honestData.triage`, and every waiver is
a row in the preview, so a reader can overturn one by eye. Triage unreachable →
nothing is waived, which is exactly what this check did before the stage existed,
and `honestData.degraded` says so. Recorded as `skipped-by-triage`.

**3. The auditor — only executed code clears a value.** Every remaining claim
goes to a pinned auditor (`AUDITOR_CONTRACT` in `src/audit.ts` — model,
`auditVersion`, and a hash of its prompt, stamped into `result.json` too) along
with the case's tool data. It may **see** the data, and it may answer with only
one thing: a **check program**, the body of a JavaScript function over a `data`
object holding one entry per tool under exactly that tool's name — keyed rather
than one variable each, because `TOOL_NAME_PATTERN` permits names JavaScript
cannot bind (`report-total`). The harness runs that program in a `node:vm`
sandbox — no imports, no `require`, no I/O, no globals beyond the tools' own
data, code generation off, 250 ms deadline — and compares what it returned
against the number on screen, at either money scale.

**Only that comparison clears a value. The auditor's prose is never read.**

- A program containing the value it is meant to derive — at any scale, in any
  notation, so `9999`, `9999.00` and `999900 / 100` all count — is rejected
  before it clears anything, and the attempt is spent if it is refused. Writing
  the answer down proves nothing. Digits inside a **string literal** are not
  writing it down, because that is how a row is selected
  (`find((job) => job.id === "J-2444")`). Everything else is settled by a
  **counterfactual run**: the same program again, over the same rows with every
  number taken out. An answer that does not change was never read off the data —
  `data; return 3` returns 3 either way — and an answer that does change was,
  which is what lets the `* 100` in every honest percentage through. That used to
  be an allowlist of common constants, and it cleared every fabricated 3, 12 and
  100 on every screen: a closed list of exemptions is a closed list of ways
  through.
- **Two attempts** per value, then it stays an offender, `why: "no executable
  derivation found"`.
- **One call per round**, covering every value still unresolved at once, and
  **up to two rounds** — a value rejected in the first gets one retry before it
  stays an offender, so a screen with a hard value can cost two calls, not one.
  **No call at all** when stages 1 and 2 took everything, and no call from either
  stage when stage 1 alone did.
- Auditor unreachable → its values stay offenders and `honestData.degraded` is
  true. A degraded check then scores nothing rather than failing the floor: an
  outage in the benchmark's own machinery is never the contender's failure, which
  is the posture the judge has always had.
- Dates are never graded: they are consumed before the numbers are read, because
  the comparison that clears a value is numeric and there is nothing here that
  could execute against one.

Every examined value is recorded in `result.json` under `honestData.audited` —
the value, which stage settled it, the program verbatim where one ran, what
executing it returned, the verdict and the attempt count — and shown in that
column in the preview. What the triage and the auditor cost is one line under the
run header, priced through the same table as everything else (both are pinned to
the same model, so one price covers both), and never added into a contender's
`cost`.

## The judge

What the floor cannot settle: one verdict per rubric line — the case's `pass`
lines (did it do what was asked) and the world's `style` lines (does it look
like the product it claims to be) — from a pinned `claude-opus-5` that is shown
the screenshot, the click trace and the source.

It grades **blind**. Nothing it is sent names the contender, its model or its
run folder; the SOURCE channel is `page.html` for every column, because vendo's
artifact is TSX and both baselines' is HTML and that is a perfect classifier for
which column is the vendor's. The lines arrive shuffled and are mapped back
after, and the shuffle is **seeded from the case's own stamp**, so one case is
asked in one order — the same for every column of it and the same on every rerun.

Every verdict is `pass`, `fail` or `na`, and carries one clause naming the
evidence it was reached on. Each line arrives labelled `[correctness]` or
`[design]`, because only a DESIGN line may honestly be `na`: its subject may
genuinely be absent from this screen, so it is neither earned nor missed and sits
out of the tally. A correctness line is what the case asked for, so a screen with
no sign of it did not do it, and an `na` there scores as a fail — dropping it
shrank the denominator, and omitting a feature outscored building it imperfectly.

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

- **`[class*="recharts-cartesian-axis-tick"]`** — the scale. A chart of the
  spending case draws `$0.00 / $750.00 / $1,500.00 / $2,250.00 / $3,000.00` down
  its axis, and not one of those is a value any tool returned. Graded, every
  honest chart fails; ungraded, the check keeps its meaning everywhere else. Both
  the tick layer and the tick values, so a hand-written chart that names its ticks
  the way the Kit's does is read the same way.
- **`#recharts_measurement_span`** — an offscreen scratch pad at `top:-20000px`
  holding the last string recharts sized. No human has ever seen it, and
  `innerText` reports it anyway.

**The same exclusion on every page, whoever wrote it.** It was once the Kit's
alone — a contender's own document got none of it, on the reasoning that those
class names in hand-written markup would be a hiding place rather than a chart.
That reasoning graded the harness: a Kit chart's axis was measuring marks and an
identical hand-drawn axis was fabrication, so the columns that cannot use the Kit
were failed for drawing the same picture. What the text IS decides, not who
emitted it.

**The cost, stated plainly:** the exclusion is a whole tick layer, so the
category axis goes with the scale. A number or date that appears **only** on a
chart axis and nowhere else on the screen is **not graded, for any contender** —
and any contender may put a number there, where nobody, its author included, can
read it as a claim about the data. Everything else still is: a fabricated number
in the screen's own copy fails exactly as before. `tests/axis.test.ts` pins every
half in a real browser: the labels really are in the page's own text, really would
fail, are gone from the extraction on a compiled page AND on an authored one, and
the screen's own copy is still caught. It fails loudly if recharts ever moves that
text.

One consequence follows from the same exclusion: a screen whose only text IS
excluded chart scaffolding — a chart and nothing else, no caption, no label in
the screen's own copy — passes `honestData` unexamined, not because it was
checked and cleared but because there was nothing left to check. `examined` in
`HonestDataResult` is how a reader tells the two apart: a real pass carries the
count of values it cleared, and a vacuous one carries `0`. `wiredActions.pressed`
is the same field for controls, and the preview mutes both vacuous passes rather
than printing the checkmark a real one earns.

## Tests

`pnpm --filter @vendoai/genbench test`. `vitest.config.ts` caps the pool at 1-2
workers and drops the browser suites when `CI` is set, because CI installs no
Playwright browsers.

Two tests spend real money, and both are gated twice — they need
`GENBENCH_LIVE=1` **and** `ANTHROPIC_API_KEY`, so neither CI nor a stray
`vitest` run can trigger them: the judge's live smoke test (`tests/judge.test.ts`)
and the Claude Code driver's (`tests/claude-code.test.ts`).

## Known limits

Shipping the face changed `world.hash`, so runs from before this slice do not
compare with runs after it. Unifying the two baselines onto one serializer
changed the `diy` prompt's wording too, and the shared `HARNESS_CONTRACT` changed
both baselines' prompts again: the numbers start again at each of those.

A number that appears only on a chart axis is ungraded for every contender (see
above) — a real hole, opened knowingly, because the alternative was grading one
column's chart and not another's.

The probe presses one control per fresh page, so a screen with many controls
costs many reloads. Multi-step flows are only followed one step past a
`[role=dialog]` confirmation. A control that navigates off the screen — a link
with an `href` — is recorded as having gone somewhere and called nothing, which
is the only thing that can be read once `window.vendo` has left with the page.

The `vendo` column cannot be cancelled mid-generation. A case that outruns its
budget forwards the abort to `diy` and to `claude-code`, both of which stop; the
product's own assembler has no cancellation seam to hand it to, so that column
runs on until it finishes and its tokens are billed either way.
