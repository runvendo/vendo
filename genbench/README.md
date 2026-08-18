# genbench

Answers "why not build this in-house?" with numbers.

It runs hand-written prompts through five contenders — the real Vendo pipeline,
two raw-Claude baselines, a rival coding agent and one bought product — against
fourteen fictional products defined entirely in JSON, scores what comes back, and
measures time and money. The three Claude contenders get the same model, the same
tools, the same schemas, the same design brief and the same harness contract,
because that equivalence is the whole claim; `codex` asks that same in-house
question of another vendor's agent, so it brings its own engine and its own
model; the bought product gets the same world and is configured as its own vendor
says to configure it, which is a different claim and is spelled out under
[The bought product](#the-bought-product).

## The contenders

| contender | what it is |
| --- | --- |
| `vendo` | the real product: the screen assembler, the guard, the apps runtime, the compiler and the Kit. Its artifact is the TSX screen it saved (`artifact.tsx`), and the page is that screen's compiled payload mounted through the product's own renderer |
| `diy` | the cheap in-house build: ONE `streamText` call, one HTML document, no product. Its artifact IS the page — no compile, no Kit, no mount |
| `claude-code` | the strong in-house build: the stock Claude Agent SDK with its stock loadout — Bash included — writing and rewriting one `index.html` in a scratch directory. What is taken away is isolation and not capability: the operator's own settings, MCP config and shell environment stay out, because a laptop's private tooling would silently become this column's advantage. Its artifact IS the page too, and it is billed by its own session rather than by the run's meter |
| `thesys` | the BOUGHT build: Thesys C1 (docs.thesys.dev), a hosted generative-UI API — the closest competing product on the market. Not another way to prompt a model, but a purchase: their model, their system prompt, their UI DSL, their React renderer. Its artifact IS the page, with their renderer inlined into it. See [The bought product](#the-bought-product) |
| `codex` | the same build from the other vendor: OpenAI's Codex CLI with its stock loadout, writing and rewriting one `index.html` in a scratch directory, and isolated from the operator's own `~/.codex` config for the reason `claude-code` is isolated from theirs. Its artifact IS the page too, and it is billed by its own session against the OpenAI platform account |

The three Claude columns are handed the same thing, and that is asserted rather
than asserted-to-be. There are exactly **three shared texts** — `worldBlock` in
`src/vendo.ts`, the world every contender is briefed on; `HARNESS_CONTRACT` in
`src/render.ts`, the mechanical seam every page-writing contender must satisfy;
and `TOOL_ACCESS`, also in `src/vendo.ts`, which the two columns that get a
working directory are sent. `tests/diy.test.ts` then compares the prompt each
baseline really put on the wire (the model `diy` streamed through, the session
`claude-code` opened) against the briefing pack the vendo driver composes
(`renderBriefingPack`) and the descriptors its registry serves — byte for byte,
for every baseline — and asserts that the responses that registry really returns
appear in **none** of them. It also fences the DIFF: whatever is left in a
baseline's prompt after those shared blocks must say nothing about
`window.vendo`, the settle signal, confirmations, the viewport or the network.
`claude-code` was once coached on all five while `diy` was told none of them,
which grades the coaching rather than the screen. If any side drifts, the test
fails and the comparison is void. It is the benchmark's credibility, so it is the
first test to read.

### Nobody is given the data

**No contender is told what any tool answers with.** Every column gets the same
thing instead: schemas, and a way to call. A screen fetches its own data at render
time through `window.vendo.callTool(name, args)` — the synchronous bridge the
harness injects into every page (`seam` in `src/render.ts`), which answers the
same for whoever wrote the document.

That is a correction, not the original design. `worldBlock` used to print each
tool's real rows under `returns:`, so a baseline could paste them into static
markup and be right, while the vendo column spent its loop CALLING for the same
rows — two different exams under one score, with the honesty rubric line grading
transcription on one side and tool use on the other.

The two columns with hands get one thing more, because an in-house team building
against its own API has it too: each agentic driver writes an executable
`world-tools` into the workspace it opens (`installWorldTools` in `src/vendo.ts`),
and `./world-tools <name> ['<json args>']` prints the same
`{ status: "ok", output: … }` envelope the page's bridge answers with. It is for
LOOKING while building; the delivered page still has to fetch for itself, and
`TOOL_ACCESS` says so in the same bytes for both. `diy` is one model call with no
directory, so it is told about no such thing — its only access is the page's, at
render time, which is the whole of what a one-shot generation gets.

The vendo column needs no such contract and is not given one: the product itself
wires `window.vendo.callTool` and `window.__settled` through `mount.tsx`, applies
the theme through `applyThemeVars`, and hands its writer the shipped
`building-apps` skill and format reference — which is where that column's
equivalent guidance (how a screen calls a tool, when to confirm) already lives.

### The bought product

`thesys` answers a different question from the other three: not "why not build
this in-house?" but "why not buy the closest thing already on the market?". It is
**product against product**, and it is configured best-effort, the way the
vendor's own docs say to configure it. Everything about that configuration is in
`src/thesys.ts` and can be read and argued with.

- **It gets the same world.** `worldBlock` — the same bytes the two baselines and
  the screen assembler are handed — is its entire system prompt, and the case is
  its entire user turn. `tests/thesys.test.ts` asserts that the request really on
  the wire carries exactly those two messages and nothing else of ours. That
  includes the data rule: it is told what the tools take and return in shape,
  never what they answer with.
- **It can call the world's tools while it builds.** The same derived schemas, as
  the ordinary OpenAI tools array their own docs say to hand a C1 agent
  (`integrate-data/tool-calling`), with the driver running the loop and answering
  each call with `cannedResponse` in the envelope `world-tools` prints for the
  agentic columns. It has no working directory, so this is where its `TOOL_ACCESS`
  equivalent lives: no column reads data in a prompt, and a column that cannot
  call is one drawing from schemas alone. Bounded at six turns, each a billed call
  plus the vendor's flat per-call fee. Whether their DSL then fetches through
  `window.vendo.callTool` as it renders is **their product's** answer to the
  same question every other column is asked, and this column wears it honestly.
- **It is NOT sent the harness contract**, and it is exempt from the byte-equality
  prompt test that covers `diy` and `claude-code`. Two reasons, and they are the
  same reason twice: the system prompt this column actually runs on is the
  **vendor's** — roughly 18k tokens of it, billed to us and unobservable — so
  there is no byte to compare; and none of the page's mechanics are asked of the
  model here. Its wiring is **mechanical**, done by the driver exactly as
  `mount.tsx` does it for the vendo column, so a contract telling the model to
  wire `window.vendo` would be coaching it on work it does not do.
- **Its model is the vendor's, not ours.** `c1/anthropic/claude-sonnet-4.6/v-20260331`,
  their newest first-party (non-OpenRouter) Anthropic model. A host does not pick
  the model here the way it does in every other column, so this contender runs
  that one alias and nothing else, and no other contender may run it.
- **The world's tools are declared as C1 custom actions**
  (`metadata.thesys.c1_custom_actions`, a JSON *string* on the wire), with the
  same derived input schemas the vendo registry serves — so their model attaches
  real action types and schema'd params to the controls it generates, and a press
  reaches `window.vendo.callTool` through their own `onAction`.
- **Its theming is a mapping, and it is published.** `crayonTheme` in
  `src/thesys.ts` maps the world's `VendoTheme` colours, font family, corner
  radii and chart palette onto their theme tokens. Their `Theme` type is
  undocumented, so the names were read off the type and presets they ship — their
  charts take a ten-step ramp of one hue, so the world's single accent is mixed
  into one. Their ladder is finer than a `VendoTheme`'s: anything the world does
  not name — the wider radii, the shadows — keeps their default, and this column
  wears that difference honestly.

What it is **not** given: a model turn AFTER the screen. Their product refreshes a
screen after a press by generating again, and this benchmark grades one screen per
case for every column — so a press is recorded and the screen does not move. That
is a real difference between the products, and it is reported rather than patched
around.

Everything after the bytes land is the same code for every column: the same
injected recorder, the same `@font-face`, the same screenshot, the same click
probe, the same floor and the same judge.

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
row: `vendo`, `diy` and `thesys` answer in one model loop and keep a five-minute bound,
while `claude-code` and `codex` each run their own ten-minute wall clock inside
the driver before they have delivered anything, so those cases get twelve. A
shared five-minute bound would have ended both columns early and reported a
timeout neither contender ever had.

## Run it

```sh
pnpm build                                  # genbench reads the built @vendoai/* dists
ANTHROPIC_API_KEY=… pnpm genbench run --prompt spend-overview
```

Each case writes `runs/<run>/<contender>/<case>/`, where `<contender>` is the
column's slug — `<harness>-<model>`, e.g. `vendo-sonnet`, `diy-gemini`,
`claude-code-haiku`, `thesys-c1`, `codex-terra`:

| file | what it is |
| --- | --- |
| `artifact.tsx` | the screen the contender actually saved — TSX bytes, hence the extension (vendo only — a contender whose outcome says `format: "html"` has already delivered a document, and it lands once, as `page.html`) |
| `page.html` | the real screen: for vendo a root, the payload and the product's own renderer bundled in; for `diy` and `claude-code` the document each wrote. This is the only way pixels are made |
| `screenshot.png` | that page, shot once it has settled — the **viewport**, 480x900, which is the frame the harness contract promises and the only one the judge is shown |
| `dom.html` | what the browser held once that screen settled, script bodies dropped: the judge's SOURCE evidence, saved because it is what lets the folder be scored again without painting anything |
| `result.json` | the four floor verdicts, the judge's verdict for every rubric line, the contract the run graded under, the commit the harness ran at and the Agent SDK version, the click trace, console errors, timings, tokens and dollars. `cost.usage.reasoningTokens` splits out the part of the output the provider says was THINKING rather than written — a split of `outputTokens`, never an addend, so no dollar moves for it, and absent entirely where the provider itemises no such count, which is every first-party Anthropic call |

one `runs/<run>/summary.json` — the run's only aggregate, per column: floor cells
earned, failed and vacuous; rubric case-lines and style-lines by
verdict; timeouts; degraded judgements; how far the screens that were ASKED to
act actually got (`actions`, below); how long the column took (`settledMs` as
median, p90 and worst, plus the median first render where a column reports one);
total tokens and dollars; and the
gitSha, model ids and rubric version the numbers were produced under. One
honest JSON, no CSV and no charts.

And one `runs/<run>/preview.html`, which is where a person actually looks:

- **the run's floor score by shape**, at the top, and ruled off under it each
  column's duration — the median case, the p90 and the worst, in seconds.
  Half of buy-versus-build is time, and one number per screen is not an
  answer to it
- **the write row**, ruled off beside it: of the cases that ASKED a screen to do
  something (`action` in `cases.json`), how many of a column's screens had a
  press reach a tool the world declares a **write** — one with no canned data —
  with the screens that got only as far as a confirmation counted beside them
  (`1/3 · 1 dialog`). It reads the presses the SCREEN answered — a write that
  happens one press inside a dialog is on that dialog's paths, not in the screen's
  bindings, so a confirm-gated screen still counts as `dialog` here even though
  the floor can now see its write. Reported, never gated, and read back off
  bindings already on disk: `genbench report <run folder>` fills it in for a run
  recorded before the axis existed, with no model and no browser
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
- **the world-data panel** — collapsed: every tool the case's screens could
  call, what it does, and the exact response it answers with, overrides
  applied. It is what makes any number on any screen checkable by eye, and it
  is the same data the judge is shown to grade the honesty line on
- **the tool-call feed** — pinned to the bottom. Press anything in any embedded
  screen and the call it fired lands there, tagged with the contender whose
  frame fired it: `14:32:05 · diy-sonnet · cancel_transfer {id: tr_1}`. A
  control that fires nothing writes nothing, which is the same verdict the floor
  reaches

It stays one static file — no server, offline, forever. A contender that
outruns its budget is recorded `failure: "timeout"`; its siblings finish
normally.

Flags: `--prompt <id>` for one case, `--models sonnet,opus,haiku`, `--world
<name>` (default `maple`), a comma list like `--world maple,buildlog`, or
`--world all` for every world in one run folder — which is the only way to get
one number for the whole corpus.

A bare run races **seven columns** (`DEFAULT_MATRIX` in `src/run.ts`) —
`vendo-sonnet`, `diy-claude`, `diy-gpt`, `diy-gemini`, `claude-code-sonnet`,
`thesys-c1`, `codex-terra` — every contender once, each on the model its column
is bought for, and all of them in ONE price band: Sonnet 5, GPT-5.6 Terra and
Gemini 3.1 Pro list within a dollar of each other on input. A flagship set
against another vendor's mid-tier measures a price tag rather than a product, and
this benchmark exists to answer buy versus build. Every column in that row is a
pinned pair, so `--models` does not reach into it; `--contenders` is the door to
anything else, the flagships included.

`--contenders` takes a bare harness, crossed with every `--models` alias, or a
pinned `harness:model` pair, which is exactly that column and skips the cross —
so `--contenders vendo,diy:gpt,codex:terra` is those three columns and nothing
else. The matrix stopped being a rectangle once some columns had a model line of
their own, and naming a model to get one column of it used to cross that model
onto every other harness in the row.

The cross-vendor row arrives through OpenRouter as one alias per vendor: `claude`
(`anthropic/claude-sonnet-5`), `gpt` (`openai/gpt-5.6-terra`) and `gemini`
(`google/gemini-3.1-pro-preview`). All three run on `diy` alone — the one column
that is nothing but a model call, which is what makes three vendors comparable —
and they need `OPENROUTER_API_KEY`.

The two product columns each run their own alias and nothing else, and no other
column may run theirs: `thesys` on `c1` with `THESYS_API_KEY`, `codex` on `terra`
with `OPENAI_API_KEY`, both beside `ANTHROPIC_API_KEY`, which the judge needs
whoever built the screen. Every key is demanded before the
first case rather than a case and a browser later, and only for the columns the
row really runs: narrowing `--contenders` narrows what is demanded with it.

A `--prompt` run opens the preview on macOS when it finishes — that is one
person watching one case, and a window is the point of it. A full run prints the
path instead, and `CI` or `GENBENCH_NO_OPEN=1` suppresses the window entirely.
The path is always printed either way.

### The cheap sweep

`--floor-only` runs each case the whole way — generate, paint, probe, and the
mechanical floor — and asks **no judge at all**. The floor is deterministic,
local and free, so this is the regression gate that can be pointed at the whole
corpus the day something lands (`pnpm genbench run --world all --floor-only
--jobs 4`) without spending the judge's ~$0.03 a case on verdicts nobody is
asking to change. `--contenders`, `--world`, `--models` and `--jobs` mean exactly
what they mean in a judged run, and the flag itself takes no value. A skipped
judgement is recorded as **no rubric at all** rather than as failed lines — so
`summary.json` counts it in neither the ask nor the design column, and no column
is scored for an exam it never sat — and each screen's card in the preview says
`floor only` where its verdicts would be. The exit code is the floor's, exactly
as it is in a judged run.

### Scoring a saved run again

The floor and the rubric move — honesty left the mechanical floor and became a
judge line — and every screen already recorded was then scored under a contract
no new screen will ever be scored under. Building those screens again is hours
and hundreds of dollars for work that is already on disk, so `regrade` scores
the folder instead. It takes the run and the same `--jobs`:

```sh
ANTHROPIC_API_KEY=… pnpm genbench regrade runs/2026-08-17T09-09-03 --jobs 4
```

It decides again only what today's code decides differently — `delivered` and
`wiredActions`, off the saved artifact and the saved trace, and every rubric line
from the judge — and CARRIES the rest: `renders` and the product's own blocking
findings were settled by machinery that has not moved, and the timings and the
contender's dollars are what that contender really spent. The only new money is
the judge's, about $0.03 a case, and it lands in `judged.cost` as always.

Nothing is regenerated and nothing is pressed again: the trace on disk is the
trace. A run recorded before `dom.html` was saved beside the shot has its settled
DOM recovered by painting `page.html` once, in the same headless browser the run
itself used.

The source folder is never written into. The re-scored run is a new folder beside
it, naming where it came from in `summary.json` (`regradedFrom`), with the page,
the picture and the artifact hard-linked in rather than copied — so it is a whole
run to open and not a second copy of one. A case whose `world` hash or `caseHash`
matches nothing under `worlds/` is refused out loud and left out of it: that
screen was built against a product that has since changed, and grading it against
today's tool data would report the edit as the contender's score. A refusal is
the one thing besides the floor that exits 1, and the last line says both:

    floor failures: 0 · not regraded: 1 (exit 1)

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
judge. A world is **ten or fifteen cases**, so one world's
run is roughly 10-15x that; `--world all` is **200 cases**, and nobody runs that
casually. `--models` multiplies the whole thing again by the number of models,
because the matrix is every harness in every model.

Every dollar comes from the price table in `src/meter.ts`, **priced as of
2026-08-08**: Opus 5 at $5/$25 per MTok, Sonnet 5 at its introductory $2/$10
(through 2026-08-31, after which it returns to $3/$15), Haiku 4.5 at $1/$5. The
token counts beside every dollar are the durable number — the dollars are a
reading of that table on the day the run happened, so two runs' dollars only
compare if the table did not move between them.

The bought column is priced the same way, plus a fee no in-house column has.
Thesys pass through the underlying provider's token rates with no markup, so its
row is Anthropic's Sonnet 4.6 list rate ($3/$15), and their flat **$0.002 per API
call** — the Build plan's rate, read 2026-08-16 — is added by the driver rather
than smuggled into the token table. A plan's included calls are a subscription no
other column has, and this benchmark does not model one. In practice one case on
this column is a few cents: its prompt carries their own ~18k-token system prompt,
which is billed to us on every call and cannot be read.

The router's rows and the codex row are **priced as of 2026-08-17**. OpenRouter's
own listing gives `anthropic/claude-sonnet-5` at $2/$10 — identical to
first-party, introductory period and all — and `google/gemini-3.1-pro-preview` at
$2/$12, the ≤200k context tier, which a 10-20k-token genbench prompt never
leaves. OpenRouter takes **no cut of tokens**: what it really charges is 5.5%
(min $0.80) on credit top-ups, which is not a per-token price and is therefore in
no number this benchmark produces.

`openai/gpt-5.6-terra` is the exception and is priced at **$1/$6, half its own
$2/$12 list rate**: the router's OpenAI endpoint carries a 50% discount on Terra
today, while its Azure and Bedrock endpoints for the same model — and OpenAI's
own pricing page — quote the undiscounted rate. That is a real bill and a
temporary one, exactly as Sonnet 5's introductory rate is, and when it expires
this row goes back up. `codex` is priced at OpenAI's own **$2/$12** for the same
model, because its CLI bills the platform account directly rather than through
the router.

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
scale error slip past the honesty line. `tests/worlds.test.ts` lints every
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

Four checks, all **deterministic**, and no model touches any of them:

- **delivered** — an artifact came back at all
- **renders** — the page mounted and took up space, with nothing on the console
- **valid** — the product's *own* checks floor blocks nothing in the saved bytes.
  Not the same as "something painted": the agent can save again after its last
  good view, and the seam keeps the older screen. A contender with no compile
  step has nothing to block, so for `diy`, `claude-code` and `codex` this check collapses
  onto `delivered` — the checks that do the work on a hand-written page are `renders`
  and `wiredActions`, and both are the same code
- **wiredActions** — the probe pressed every control on the page and every call
  that fired names a real tool with schema-valid arguments. A control that fires
  nothing fails: naming a tool in a document is not being wired to it, which is
  the difference `tests/probe.test.ts` exists to keep honest. A case tagged
  `action` has to show one press that really called a tool — or a confirmation
  that WORKS, which since 2026-08-17 means the probe pressed inside the dialog
  and found both halves of it (below). A screen asked to DO something and proven
  by zero tool calls is not proven. `pressed` records how many controls there
  were to press, so a screen that passed with none is distinguishable from one
  whose controls all held, and the preview prints both

A pass on the last one is not always a pass. A screen with nothing to press
clears it **vacuously** — it was neither earned nor missed, so it stays out of
the run's totals (`checks` in `src/floor.ts`, which is what the shape table and
`summary.json` both add up) and is counted beside them instead. Summing bare
booleans is how a blank page came to score full marks in the only aggregate this
benchmark had.

Fabrication used to be a fifth check here, which cut every digit group out of the
screen's text and paid two models per screen to settle them — one to say which
tokens were claims at all, one to write arithmetic the harness executed. It is a
rubric line now, graded by the judge against the tool data the judge is shown.

### What the probe presses (2026-08-17)

Every **species** of control a person can press, by the role it answers to:
`button`, `[role=button]`, `a[href]`, `[role=switch]`, `[role=checkbox]`,
`[role=radio]`, `[role=menuitem]`, and the browser's own `input[type=checkbox]`
and `input[type=radio]`. A control marked `aria-hidden` is skipped: Base UI pairs
the switch or radio a person presses with a hidden proxy input that carries the
form value, and pressing both would grade one control twice.

Buttons alone was the whole list until tonight, and it measured
**reachability-by-probe rather than wiring**. Three of the four `vendo` floor
failures in the 39-case post-mortem were screens whose actions are correctly
wired and were simply unreachable: a screen whose only actuators are `Switch`
toggles, each one bound to a tool, recorded `pressed: 0` and failed its `action`
case — while a screen of always-enabled buttons that call nothing recorded a
press each and scored better for being button-shaped.

A control the screen has **locked** gets one precondition satisfied. If it is
disabled and the screen carries a `<select>`, every select is set to its first
real option — one pass, document order, skipping the placeholder whose value is
empty — and the control is given a second look, bounded by a second. "Pick an
agent, then press Assign" is a correctly built screen, and it was the other
failing shape. Only a `<select>`, and only to an option the screen itself offers:
a value the harness typed would be data no screen claimed, riding into a tool
call the judge then grades as the screen's own. Nothing hunts for the combination
that unlocks a screen, and a control still locked after that one pass goes
**unpressed and ungraded** — a screen being careful is not a screen with a dead
control.

What a press DID is read the same way for every species, with one number added to
the two that were already there: how many of the screen's controls are switched
on (`[aria-checked=true]`, `:checked`), beside its text length and its element
count. A toggle that flips changes neither of the other two, so without it every
toggle bound only to local state would have been graded dead the moment the probe
started pressing toggles.

Nothing about what PASSES moved with that widening. A pressed control still has
to call a real tool with valid arguments or visibly move the screen, and a dead
always-enabled button still fails — the widening is in what gets pressed, and it
is the same widening for every column. What a confirmation has to show DID move,
later the same day, and that change is next.

### Inside the confirmation (2026-08-17)

**The probe presses inside a `[role=dialog]` now**, and an `action` case's bar
moved with it. This changes floor outcomes **in both directions**, so no run
recorded before this compares with one after it.

It used to stop at the dialog: it recorded that one opened and the words it
showed, and pressed nothing inside. That made a confirmation wired to NOTHING
indistinguishable from one that acts — both left the identical record, and both
cleared an `action` case on the opening alone. A completely dead confirmation
passed. Worse, an action that lives behind a dialog could never be evidenced at
all: a rubric line like "pressing approve fires approve_refund" asks about a call
that happens one press past where the evidence ended, and last night's audit
found several such lines failed by **every** column for exactly that blindness.

So when a press opens a dialog, every control inside it is pressed once — each on
a **fresh page**, walked back to the dialog from scratch (reload, the choice the
screen asked for if the opening control needed one, then that same press), which
is the isolation discipline the screen's own controls already get. What each path
called, with its arguments, and whether the dialog closed or the screen moved,
goes on the trace as `inside` (`Path` in `src/probe.ts`). Only what a person can
actually press counts as a path: a control that is hidden or locked inside the
dialog is not a way out of it.

An `action` case's confirmation then has to show **both halves**:

- at least one path that **writes** — a tool the world declares with no canned
  answer (`riskOf` in `src/world.ts`, the same reading the write row uses),
  called with schema-valid arguments. The screen really goes through with it
- at least one path that **does not write** — the person can decline. A dialog
  whose every button writes is as broken as one where none does

Writes rather than tool calls of any kind, because a real decline is not silent:
half the confirmations in the saved corpus close by re-reading the list they came
from ("Keep request" → `list_time_off_requests`). Graded on "a path that called
nothing", that working screen would be convicted for refreshing; graded on "a
path that called anything", that same refresh would stand in as the confirm on a
dialog whose confirm button is wired to nothing. Both misreadings are in one
saved run, in opposite directions, which is what settled the wording. Every
consequential verb in all fourteen worlds is a write, so nothing an `action` case
asks for falls outside it.

A dialog with **one pressable** control has no second path to be read against, so
it is judged by that control's behaviour alone, and the trace says so in those
words. A dialog with nothing pressable in it proves nothing. This is where a
confirmation guarded by something the probe cannot supply lands: a "Deny this
request?" dialog whose *Deny & Notify* is disabled until a reason is typed shows
one pressable control — *Cancel* — so its deny is recorded as unproven rather
than as working. The dialog's full text still reaches the judge, disabled button
and all.

Which path is the "Confirm" is still **not the probe's business**. It presses
them all and records what each did; the judge reads the dialog's words and
decides which was which — "Cancel" in a dialog about cancelling means the
opposite of "Cancel" beside it. The judge's trace reads
`inside the confirmation, pressing "Yes, cancel it" called cancel_transfer({"id":"tr_1"}); pressing "Keep it" called nothing, and the screen moved`.

`HARNESS_CONTRACT` says the same thing to every page-writing contender, in the
one wording all of them get: the harness presses each control in the dialog, the
one that goes through must call the tool that does the work, and the one that
backs out must not call it.

Writes are canned here — the world answers success without keeping state — so
pressing a confirm changes nothing a later case could inherit. The isolation is
kept anyway, and by construction: every path is walked on a page painted from
scratch, so no in-dialog press can see what another one did, and the candidate
that follows is pressed on a page that has forgotten all of it.

## Liveness

Whether a screen is **bound** to the host's data or merely **decorated** with it.

Every page carries the world's canned tool answers as one injected seam — the
`tools` JSON `render.ts` writes into every contender's document, the same bytes
whoever wrote the page. So the screen can be asked the question a screenshot
cannot answer: paint it, move every number in that seam, paint it again, and see
which of the figures on it moved. A screen that asks the host at render shows the
new numbers. A screen that baked them at generation time shows yesterday's, and
looks exactly as correct doing it — which is the failure a demo never surfaces
and a real user hits on their second visit.

The mutation is **+1 at the ones place**, at the decimal places the world
authored: the smallest change that must show if the screen is reading the value,
and small enough that it cannot reorder a sorted list, reshape a chart or make a
figure implausible — the page renders as it did with one digit different.
Arithmetic only, no clock and no randomness, so the same saved run scores the
same today and next month. Strings and dates are left alone: a number is a claim
about the data, a label is not.

The comparison is on **digits**. Worlds hold money in cents and screens show
dollars, so `285000` reaches the eye as `$2,850.00`; both sides drop the group
separators and the decimal point, and a value under three digits is not counted
either way — a one- or two-digit run matches by accident in any screen with
numbers on it, so a match on one is evidence of nothing.

The digit search is the **instrument and the optimist**, never the verdict.
Finding a value's new digits on the repainted screen is evidence and settles it —
that value is live, and no model is asked, so a fully bound screen costs this
axis nothing. Not finding them settles nothing: a run of digits can sit inside a
longer figure without the screen ever displaying that value, which is how
`people-ops/headcount-overview` once scored 5/6 with every figure computed at
render — the world's `250000` falls inside the payroll total `171250000` the
screen prints, and a total of four rows moves by four, not by one. So every
**stale accusation** goes to a model, one small call each, exactly as the honesty
check stopped matching strings and became a line on the judge's rubric. It
answers `stale` — the screen really is displaying this value and printed the old
one — or `not-a-data-echo` — those digits are part of another number, an axis
tick, a rounded or derived figure, so there was nothing here to update. An
adjudicator that cannot be reached leaves the accusation **unadjudicated**:
recorded in full and counted in neither direction, because a check that could not
be run is not one that passed.

The score is `live / displayed` **after** that: only an upheld accusation is in
the denominator, and every accusation is listed under `adjudications` in
`result.json` — value, verdict, one-clause note and what deciding it cost — so a
reader can audit each one rather than take the ratio on trust. The adjudicator is
pinned and stamped like the judge (`AdjudicatorContract`: model id and prompt
hash) at the cheapest Anthropic tier the meter prices, which is a tier no default
column races, so no screen is audited by its own model class. A screen that
displayed none of the moved values is **vacuous** — neither bound nor baked, out
of both totals — the same doctrine a `wiredActions` pass with nothing to press is
counted under.

It measures **binding, not recomputation**. A screen that echoes a raw value it
re-read scores live even where a total it derived from that value stayed stale:
the claim is that what is printed followed the data, not that everything
downstream of it did.

Nothing gates on it. `floor.pass`, the exit code and every rubric line are blind
to it — it is **reported**, in `result.json` as `liveness`, in `summary.json` per
column, and in the preview as its own row under the floor cells, beside the
clock and uncoloured for the same reason. A fresh run scores it automatically,
at the cost of two extra paintings per case plus one small call per accusation,
outside the contender's budget: the instrument is not the person's wait, and its
spend is reported beside the columns rather than folded into one.

A run already on disk is scored — and its accusations re-adjudicated — in place:

```sh
pnpm genbench liveness runs/2026-08-17T09-09-03 --jobs 4
```

It paints each saved `page.html` twice, writes `liveness` into that case's
`result.json`, and rewrites `summary.json` and `preview.html` off the results it
just changed. It asks for `ANTHROPIC_API_KEY` up front: a keyless run would paint
every frame and then leave every accusation undecided. It is the one pass that
writes into the folder it read, and it is safe for the reason no other pass is:
it adds a field nothing else decides, from a mutation with no clock in it. Every
verdict already there is left as it was — nothing is re-judged and no floor cell
moves. A case that delivered no page gets no `liveness` at all, which is a
different sentence from `0/0`.

## The judge

What the floor cannot settle: one verdict per rubric line — the case's `pass`
lines (did it do what was asked) and the world's `style` lines (does it look
like the product it claims to be) — from a pinned `claude-opus-5` that is shown
the screenshot, the click trace, the source and the world's tool data.

Every case carries one line it was not authored with, right after its own:
**every number this screen shows comes from the tool data or is honestly derived
from it — nothing is invented** (`HONESTY_LINE` in `src/judge.ts`). It is a
correctness line like any other, so an `na` on it scores as a fail, and it is
graded against the TOOL DATA block — every response the case's tools answer with,
overrides applied, which is the same panel the preview shows a reader.

It grades **blind**. Nothing it is sent names the contender, its model or its
run folder; the SOURCE channel is the DOM the browser holds once the screen has
settled, script bodies dropped, captured when the shot is taken and the same for
every column — vendo's artifact is TSX and both baselines' is HTML and that is a
perfect classifier for which column is the vendor's, and the `page.html` that
first fixed that carries vendo's whole inlined runtime, which is more than a
judge's context can hold. The lines arrive shuffled and are mapped back
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
both baselines' prompts again: the numbers start again at each of those. Taking
the tool DATA out of every prompt is the largest of those breaks — before it, a
column could show the right rows without ever calling anything — so no run
recorded before it compares with one after it. Widening what the probe presses
(2026-08-17) is another: toggles and select-guarded buttons are pressed and
graded now where they used to be `pressed: 0`, so `wiredActions` — and therefore
`floor.pass` — moves in both directions, and no run recorded before tonight
compares with one after it. Pressing INSIDE a confirmation (2026-08-17, later the
same day) is a third, and the same kind: an `action` case's dialog now has to
show a path that acts and a path that declines, so a dead confirmation that used
to pass fails and a screen whose whole write lives behind a working dialog is
proven where it could not be before. Both directions again, and again no earlier
run compares — a trace recorded before it carries no in-dialog paths at all, and
absent evidence is not a pass.

The probe presses one control per fresh page, so a screen with many controls
costs many reloads, and a locked control costs one pass over the screen's selects
on top of its reload. A dialog costs one full walk back to it per control inside
it, on top of that. The probe satisfies exactly one kind of precondition — a
choice a `<select>` is asking for — so a control guarded behind a typed amount, a
ticked box or an earlier step stays unpressed and ungraded, inside a dialog as
well as outside one. Multi-step flows are followed exactly one dialog deep: a
confirmation that opens a second confirmation is recorded as a press that changed
the screen, and nothing inside the second one is pressed. A control that navigates
off the screen — a link with an `href` — is recorded as having gone somewhere and
called nothing, which is the only thing that can be read once `window.vendo` has
left with the page.

Liveness asks about the **seam** specifically: a screen that carries its own copy
of the rows — in its markup, in a recorder it defined itself, or in data compiled
into the payload it renders — reads as baked, because moving the host's answers
moves nothing it shows. That is the claim being measured and not a false
negative, but it is worth saying plainly: the number is about following the host,
not about where a screen keeps what it already has. A screen whose only figures
are on a chart axis is invisible to it for the reason those ticks are excluded
everywhere else, and a value the screen rounds (`$2,850` for `285000`) is out of
both halves of the fraction rather than counted as baked.

The `vendo` column cannot be cancelled mid-generation. A case that outruns its
budget forwards the abort to `diy` and to `claude-code`, both of which stop; the
product's own assembler has no cancellation seam to hand it to, so that column
runs on until it finishes and its tokens are billed either way.

Every page is painted **in UTC, on the day the world says it is** — never in the
operator's zone and never on the calendar's date. Both were live scoring bugs
charged to the contenders rather than to the harness: a `2026-08-12T15:10:00Z`
a tool answered painted seven hours earlier on a Pacific laptop, and the judge —
comparing the screen against tool data written in Z — correctly failed it as
invention ("timestamps like 'Aug 10, 1:12 AM' do not correspond to any tool value
(08:12Z)", both columns); and a screen calling 2026-08-12 "5 days ago" was doing
arithmetic against a wall clock days past the world's newest datum, so the same
saved page said something different every morning. The day comes from the world's
own prose — eleven of the fourteen state it, in the words their contenders are
given ("Today is 2026-08-15 and it is about 10:00 AM", "measured from now,
2026-08-12T15:10:00Z") — and `seam` writes it into every page it injects, so the
regrade and liveness repaints of a saved page use the clock it was shot under.
A world that states nothing falls back to its newest row plus a day, which is
deterministic but can overshoot, because rows carry the future as readily as the
past: `store-admin` lands on 2027-01-01 off a coupon expiring 2026-12-31, and
`trades-accounting` on 2026-09-05 off an invoice due 2026-09-04. The remedy is
one sentence of prose in that world's file — at the price every world-file edit
carries, a new `world.hash` and a fresh start for that world's numbers.
