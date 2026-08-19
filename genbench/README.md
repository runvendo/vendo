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
`{ status: "ok", output: … }` envelope the page's bridge answers a READ with — a
write is guarded at render time and answers `pending-approval` first (below). It is
for LOOKING while building; the delivered page still has to fetch for itself, and
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

### A write is guarded (2026-08-18)

The injected recorder answers a **read** on the spot, with the world's rows. A
**write** — a tool the world declares by writing no rows for it (`riskOf` in
`src/world.ts`, the same reading the write row and the confirmation check use) — is
answered `{ status: "pending-approval", approvalId }` and approved a moment later.
That is what this product does with a destructive call: it confirms it **outside
the screen**. The host parks the call, the renderer paints "Waiting for your
approval" in that control's own outcome slot (`outcomeNotice` in
`ui/src/tree/renderer.tsx`), and the decision arrives from a surface the screen
never draws.

The seam used to answer every call `{ status: "ok" }` synchronously, so the one
confirmation this product actually ships could not paint on any page here — while
a contender following its doctrine ("never build a confirm step") was failed on
rubric lines asking for one. The same injected bytes now guard every column's
page, so the round trip is the same for whoever wrote the document: the ask and
the approval both reach the preview's live feed, and the call the floor grades
carries what the guard did with it (`status`, `approvalId`) beside the name and
arguments it always carried. Nothing about the floor moved — a write with
schema-valid arguments was, and still is, what an `action` case is proven by, and
the guard is transparent to it.

The approval is granted with nobody in the loop, because there is nobody: a
benchmark page has no approvals queue and no chrome to answer from. It is granted
so the write completes, and refused never, so no column is graded on a decision
the harness invented. `tests/seam.test.ts` pins both halves — the parked answer
and the approval that follows it, on a hand-written page and on the product's own —
and that the product's notice paints on the control that asked.

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
| `screenshot.png` | that page, shot once it has settled — the **viewport**, 1280x900, which is the frame the harness contract promises and the only one the judge is shown |
| `table-1.png` | one per table the screen can only show by scrolling sideways, in the order they appear on it and at most three: that table at its **full scroll width**, which is the only way the columns past the fold reach the judge. Absent for a screen with nothing to scroll, which is most of them |
| `dom.html` | what the browser held once that screen settled, script bodies dropped: the judge's SOURCE evidence, saved because it is what lets the folder be scored again without painting anything |
| `result.json` | the four floor verdicts, the judge's verdict for every rubric line, the contract the run graded under, the commit the harness ran at and the Agent SDK version, the click trace, console errors, timings, tokens and dollars. `cost.usage.reasoningTokens` splits out the part of the output the provider says was THINKING rather than written — a split of `outputTokens`, never an addend, so no dollar moves for it, and absent entirely where the provider itemises no such count, which is every first-party Anthropic call. `pipeline` is the vendo column's own review of the screen before anyone else graded it — every verdict the product's `validate` gate reached, with its findings, and whether anything painted after the last one — so a rubric line the judge failed can be read against what the product's reviewer said about the same screen. Absent where that gate was never reached, which is itself the reading: those bytes went out unreviewed |

one `runs/<run>/summary.json` — the run's only aggregate, per column: floor cells
earned, failed and vacuous, and the same cells one tally per check
(`floorChecks`, below); rubric case-lines and style-lines by
verdict; timeouts; degraded judgements; how far the screens that were ASKED to
act actually got (`actions`, below); how long the column took (`settledMs` as
median, p90 and worst, plus the median first render where a column reports one);
total tokens and dollars; and the
gitSha, model ids and rubric version the numbers were produced under. One
honest JSON, no CSV and no charts.

And one `runs/<run>/preview.html`, which is where a person actually looks:

- **the run's floor by check**, at the very top: a row per column and a column
  per check, so a contender whose pages never compiled and one whose buttons are
  dead stop reading as the same number. Six cells — `delivered`, `renders`,
  `valid`, and `wiredActions` as the three questions it answers at once
  (`pressed`, `wired`, `actionProven`; see the floor, below)
- **the run's floor score by shape**, under it, and ruled off beneath that each
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
- **the rubric, line by line**, under each column: every ask line then
  every design line, labelled **the ask** and **design** on the page, its
  verdict and the evidence the judge named, with a tally per half. A DESIGN
  line the screen has no subject for is `na` and sits out of the denominator;
  an ask line is what the case asked for, so an `na` on one scores as a fail
  rather than shrinking the total; a judge that could not grade says so
  instead of printing a tally that would read as the contender's score
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
judge. A world is **ten to fifteen cases**, so one world's
run is roughly 10-15x that; `--world all` is **196 cases**, and nobody runs that
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

`openai/gpt-5.6-terra` is priced at its **list rate, $2/$12** — the same number
`codex` uses for the same model — not the router's temporary 50% discount on
Terra. The router's OpenAI endpoint bills $1/$6 today, but its Azure and Bedrock
endpoints for the same model, and OpenAI's own pricing page, all quote the
undiscounted $2/$12, and a coupon that can expire any day shouldn't flatter one
column over the others it's compared against. The actual bill on that column may
be lower than this table says while the discount lasts.

## The world

A world is a **folder**, `worlds/<name>/`:

| file | what it is |
| --- | --- |
| `world.json` | the entire product: identity, a `VendoTheme`, a plain-English style rubric, and ~4 tools |
| `cases.json` | the prompts |
| `font.woff2` | optional. The face the theme's `fontFamily` names, injected into every contender's page |

There are **fourteen worlds** — `maple` (consumer banking) plus thirteen more,
from build logs to trades accounting — carrying **fifteen cases** each, except
`buildlog` and `fieldops` at ten and `logistics`, `observability`,
`product-analytics` and `trades-accounting` at fourteen, so the
whole corpus is **196 cases**. A tool
that declares `data` returns rows and is graded
`read`; one that only declares `takes` mutates and is graded `write`. Input
schemas are derived from `takes` (a name → type map), output schemas from the
example rows.

**Money is in integer cents**, as the demo host and every real host API do — a
screen divides by 100 where it formats the amount itself. This is load-bearing:
a world authored in dollars lets a 100× scale error slip past the honesty line. `tests/worlds.test.ts` lints every
folder for it — and for empty reads, argument-less writes, dangling row ids,
untagged cases and overrides naming fields no tool has — at collection time, so
a world added tomorrow is linted the day it lands.

`cases.json` holds the prompts. A case may override any tool's data — that is
how the empty state is tested — and its `pass` lines are the ask-met rubric
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
  the difference `tests/probe.test.ts` exists to keep honest. Unless it moved the
  screen, or was already the active one — the tab a screen opens on calls nothing
  on purpose (below). A case tagged `action` has to show one press that really
  called a tool — or a confirmation that WORKS, which since 2026-08-17 means the
  probe pressed inside the dialog and found both halves of it (below). A screen
  asked to DO something and proven by zero tool calls is not proven. `pressed`
  records how many controls there were to press, so a screen that passed with
  none is distinguishable from one whose controls all held, and the preview
  prints both

A pass on the last one is not always a pass. A screen with nothing to press
clears it **vacuously** — it was neither earned nor missed, so it stays out of
the run's totals (`checks` in `src/floor.ts`, which is what the shape table and
`summary.json` both add up) and is counted beside them instead. Summing bare
booleans is how a blank page came to score full marks in the only aggregate this
benchmark had.

### Read one at a time (2026-08-18)

`wiredActions` held three different diseases at once, and added into one
earned/failed sum they moved that sum by the same amount: a compile crash and a
dead button read as identical. So the floor is also reported as **six cells**,
which is `splitChecks` in `src/floor.ts` — the three above, and `wiredActions` as
the three questions it really answers:

- **pressed** — every control the probe pressed did something. Vacuous on a
  screen with nothing to press
- **wired** — every call that fired named a real tool with arguments the world
  would accept. Vacuous where no press named a tool at all, since a control that
  only moves local state has nothing to recognise or validate
- **actionProven** — a case tagged `action` showed its write, or a confirmation
  that works. Vacuous on every other case: a bar nobody set is not a bar a
  column failed

`wiredActions` holds exactly when its three do, so **nothing about what passes or
fails moved and every run already on disk still compares** — this is presentation
only. The six are not a re-count of the four either: a screen can miss two of the
three at once and is still the one failed `wiredActions` cell it always was, so
`floorChecks` says which disease a column has while `floor` goes on saying how
much. It lands per column in `summary.json` as `floorChecks` and at the top of
the preview as its own table, and `genbench report <run folder>` backfills both
off verdicts already on disk — no model, no browser, no probe.

Fabrication used to be a fifth check here, which cut every digit group out of the
screen's text and paid two models per screen to settle them — one to say which
tokens were claims at all, one to write arithmetic the harness executed. It is a
rubric line now, graded by the judge against the tool data the judge is shown.

### What the probe presses (2026-08-17)

Every **species** of control a person can press, by the role it answers to:
`button`, `[role=button]`, `a[href]`, `[role=switch]`, `[role=checkbox]`,
`[role=radio]`, `[role=menuitem]`, the browser's own `input[type=checkbox]` and
`input[type=radio]`, and `select` (2026-08-18). A control marked `aria-hidden` is
skipped: Base UI pairs the switch or radio a person presses with a hidden proxy
input that carries the form value, and pressing both would grade one control twice.

A `<select>` is the one species whose press is not a click. The probe presses it by
**choosing** — the first real option that is not the one already showing — because
"pick a value and it saves" is a real screen, an `onChange` that calls the tool with
no button anywhere near it, and every one of them recorded `pressed: 0` and
auto-failed its `action` case for having nothing to press. Two worlds of one run
were built that way, nine choosers and zero buttons on a screen. *Not the one
already showing* is load-bearing: re-choosing the option a select already holds
fires no `change` at all, so a screen with no placeholder would have read as dead
however well it is wired. `[role=listbox]` and `[role=combobox]` stay out — a
listbox is the container of the options a person picks, so pressing it fires
nothing and moves nothing and would invent the very dead control this fixes, and a
combobox trigger is a `button` already.

Buttons alone was the whole list until tonight, and it measured
**reachability-by-probe rather than wiring**. Three of the four `vendo` floor
failures in the 39-case post-mortem were screens whose actions are correctly
wired and were simply unreachable: a screen whose only actuators are `Switch`
toggles, each one bound to a tool, recorded `pressed: 0` and failed its `action`
case — while a screen of always-enabled buttons that call nothing recorded a
press each and scored better for being button-shaped.

A control the screen has **locked** gets one precondition satisfied. If it is
disabled, one pass over the screen in document order sets every `<select>` still on
its placeholder to its first real option — skipping the placeholder whose value is
empty — and fills every empty box (`input[type=text]`, `input[type=number]`, an
`input` with no type, `textarea`) with the harness's own sentinel: `probe input`, or
the digit `3` where the box is a **number** (2026-08-18); then it is given a second
look, bounded by a second. The number box was the one the pass could not see, and
`project-tracker/file-bug` — "priority, assignee, estimate, and file it" — failed
`actionProven` for it: the required estimate stayed empty, the submit it guards never
unlocked, and the case recorded two choices and no press that asked the host for
anything. It takes a digit rather than the string because a number box will not hold
the string at all, so `probe input` would have left it as empty as never touching it.

**Still on its placeholder** is the
same rule as **empty** box, and it was missing (2026-08-18): the pass set every
select on the page, so a form whose priority defaults to `high` showed `high` in the
shot everybody grades and fired the call with `urgent` in it, and the judge —
comparing the screen against the call it is told about — correctly convicted the
screen of the harness's edit. A value the screen is already showing is the screen's
own, and the press should carry it. "Pick an agent, then press Assign" and "type a
reason, then press Deny" are correctly built screens, and both were failing
shapes. A value the harness invents is data no screen claimed, which is why the
probe used to type nothing at all; the sentinel is what resolves that. The fill
goes on the trace beside the press it bought (`filled` in `Probed`), and a tool
call carrying `probe input` is unmistakably the harness's, so a wire that carried
it into the arguments is **proof** the field is bound to the tool. A CHOICE says so
too as of 2026-08-18 — `chose: [{ field, value }]` beside `filled`, on the press it
was made for, from the precondition pass and from the press's own choosing alike —
in the words the option SHOWS rather than its `value`, because the words are what a
screen echoes back. It was the one thing the harness supplied that the trace never
mentioned, and it cost a correct screen a line: `project-tracker/sprint-board`
failed the honesty line on the confirmation "CAI-153 will move to \"Backlog\"", the
judge calling Backlog "an invented target not derived from the control" when
Backlog was the option the probe itself had picked one press earlier. Nothing hunts
for the combination that unlocks a screen, and a control still locked after that
one pass goes **unpressed and ungraded** — a screen being careful is not a screen
with a dead control. A form the screen never locked is pressed **as it stands**,
empty boxes and all: that is what a hasty person can do, and what the call
carries is the screen's own doing.

What a press DID is read the same way for every species, in four numbers: the
screen's text length, its element count, how many of its controls are switched on
(`[aria-checked=true]`, `:checked`), and how many a person could press right now
(2026-08-18). Each of the last two exists because a widening needed it. A toggle
that flips changes neither of the first two, so without the third every toggle
bound only to local state would have been graded dead the moment the probe started
pressing toggles; unlocking the button beside a chooser moves none of the first
three, so without the fourth the choice that opens "Pick a category, then Save cap"
would be graded dead the moment the probe started pressing choosers.

What a press REVEALED in words is recorded beside those numbers (2026-08-18): the
lines of `document.body.innerText` that are showing after it and were not showing
before, bounded at 500 characters. The numbers say something moved; they never say
what, and the judge reads this trace rather than the screen. It is carried only
where the record was otherwise blind — the press moved the screen, asked the host
for nothing, and opened no dialog — because any other press already says what it
did. No floor check reads it.

One press is read as neither a pass nor a failure: the control that was
**already the active one** (2026-08-18) — `[aria-selected=true]`, `[aria-current]`,
a radio already on, or a chooser with no option but the one it holds. Pressing it
calls nothing and moves nothing *by design*, which is idempotence and not deadness,
and the floor read it as a dead control: a `price-book` screen whose tabs work
failed `wiredActions` for the one tab a person was already looking at, in two
columns of one run. It is its own binding kind now — `already-active — a no-op by
design` — that neither earns a pass nor costs one, the way a screen with nothing to
press is vacuous rather than wrong. It has to be **detectable** to be excused: a
row's *Open* button that no-ops because that row is already open, with nothing in
the markup saying so, is still recorded as a control that did nothing.

A second press is read the same way, and it is the HARNESS's fault rather than the
screen's: a chooser that never took the value it was given. `selectOption` is
silent when it fails, so a choice that never landed was recorded as a choice that
did, with `changed: false` beside it because nothing had moved — a dead control by
every reading the floor has. The value is read back now and a choice that did not
land is made once more, once and no more, before it is believed; a chooser still
holding what it held after that is `choice-dropped — the chooser never took the
harness's value`, which earns nothing and costs nothing, and its `chose` stays off
the trace because a value the page refused is not one the screen was given.

Nothing else about what PASSES moved with those widenings. A pressed control still
has to call a real tool with valid arguments or visibly move the screen, and a dead
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

Writes keep no state here — the world guards one, approves it and answers success,
and remembers nothing — so pressing a confirm changes nothing a later case could
inherit. A screen's own confirmation is therefore a second guard in front of the
host's, which is exactly what the product allows and never requires. The isolation is
kept anyway, and by construction: every path is walked on a page painted from
scratch, so no in-dialog press can see what another one did, and the candidate
that follows is pressed on a page that has forgotten all of it.

A dialog belongs to the press that **opened** it. One already standing when the
press began is read on both sides and left off the trace: repainting a page reuses
the same script world, so a toast an earlier press opened can be portalled into
the fresh body by the previous document's still-live runtime, and the press that
happened to follow was credited with it. `buildlog/build-detail` lost *offers
exactly one control to run it again* that way — "View lint log" was recorded as
opening "Build queued to run again.", the retry toast from three presses earlier,
which the judge correctly read as a second control that reruns the build.

### The second step in the page (2026-08-18)

**A second step does not need a dialog to live in**, and the probe only walked into
`[role=dialog]`. "Press *Hand off* → an assignee picker and a *Confirm hand-off*
appear in the page" is the same shape as a confirmation, and it was recorded as
`effect: "state"` and nothing else: the controls that do the work went unpressed,
and the write went unproven one press past where the evidence stopped.
`project-tracker`'s `capacity-rebalance` and `my-issues-inbox` failed `actionProven`
that way in the columns that had the whole flow **right**.

So when a press puts pressable controls on the screen that were not there before,
each of them is pressed once, and what each called goes on the trace as `revealed`
(`Path` in `src/probe.ts`, narrated to the judge exactly as `inside` is). New is
decided by comparing the controls before the press with the controls after it, each
one identified by what it is, what role it answers to, how it is labelled and what
it says — so a control the press merely re-rendered keeps its signature and is
correctly not new, which is what stops a page that rebuilds its whole body on every
press from reading as a page where every control just appeared. A signature that was
already on the screen is never new, so a second *Save* beside a first one is missed
rather than invented.

Two things differ from the dialog walk, and both on purpose:

- **In document order, on one page**, not one control per fresh page. A dialog's
  controls are alternative ANSWERS to one question — pressing *Confirm* and then
  *Cancel* means nothing — while a reveal's are usually one FORM, and the *Save* at
  the end of it is locked until the picker before it is answered. Isolated, every
  such Save would be disabled on its own fresh page and skipped, and the write
  behind it would still be unprovable. Document order is the order a person meets
  them, it is one pass, and nothing here hunts for a combination
- **Nothing about the reveal is graded as a control of the screen.** Its paths are
  not bindings, so a revealed control that did nothing costs the screen nothing;
  the only verdict a reveal can reach is that an `action` case's write is
  **proven** (`acted: "revealed"`), which is why walking one press further moves
  the floor in one direction only

The last step of that form is often a **confirmation**, so a press inside a reveal
that opens a `[role=dialog]` is walked exactly as a press on the screen itself is:
the dialog's words and every way out of it go on that path (`dialog` and `inside` on
`Path`, the same two fields a top-level press carries). `capacity-rebalance` failed
`actionProven` a second time for the want of it, with the whole flow right — *Hand
off* reveals a picker and a *Confirm*, *Confirm* opens a Modal, and the Modal's own
button is what calls `assign_issue`, one press past where the reveal walk stopped.
Getting back to that dialog for each of its paths is the walk back to the reveal plus
the reveal's own presses in order, replayed; it has to be, because the Kit draws a
Modal's close affordance **before** its footer, so pressed in one pass the ✕ takes the
control that writes off the screen before its turn comes. **Reveal, then dialog, and
there it stops** — the dialog walk records no dialog of its own, so the depth is two
by construction and nothing can grow it.

A dialog and a reveal are never both walked for one press: a dialog's controls ARE
controls that press revealed, and walking them twice would press each way out of a
confirmation a second time without the isolation that walk promises. A control an
earlier press in the sequence took off the screen is **skipped**, not pressed into
thin air — a five-second click that lands on nothing would go on the trace as a
control that did nothing, which is the exact false failure this walk exists to stop
inventing. The cost of that is stated with the other limits: a step whose dismiss
comes before its confirm in the document loses the confirm, because this is one pass
and never a hunt.

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

The preview labels the case's half **the ask** — whether the screen delivered
what it was asked for, so this doc also calls the score **ask met** — where
both used to say *correctness*; the world's half is still **design**. This is
a display relabeling only: no verdict, tally or score moved, the judge's own
prompt is untouched, and it still tags each line `[correctness]` or `[design]`
(below).

Every case carries one line it was not authored with, right after its own:
**every number this screen shows comes from the tool data or is honestly derived
from it — nothing is invented** (`HONESTY_LINE` in `src/judge.ts`). It is an
ask line like any other, so an `na` on it scores as a fail, and it is
graded against the TOOL DATA block — every response the case's tools answer with,
overrides applied, which is the same panel the preview shows a reader.

### A fail on that line is checked twice (2026-08-18)

**A `fail` on the honesty line is an accusation, not yet a verdict.** It is the
one line no case authors, it is graded against a whole world's tool data, and it
is asked of a model that is answering a dozen questions about layout, wording and
presses in the same breath — and that is where it breaks. The vendo column's
`trades-accounting/chase-money-owed` note reconciled the buckets, reconciled the
balances, reconciled the days late and ended *"so all figures reconcile except
none — no invented number found"*, stamped `fail`. A screen was convicted by a
note that acquitted it.

So exactly one small independent check runs on a fail, and it is asked **nothing
else**: *name a displayed figure that is neither in the data nor honestly
derivable from it, or say none* — over the case's tool data with its overrides
applied, every figure the settled DOM displays, and, last of the three, the
judge's own note (`src/honesty.ts`). A fail **stands** only where that check names
a figure too.
Where it names none, the line **flips to pass** and says so in its own note. A
check that cannot be reached, or that answers outside the two verdicts, comes
back `unadjudicated` and the judge's fail stands untouched: a question nobody
answered overturns nothing.

The check's own first failure named the rest of the fix. `maple/spend-overview`
printed six raw cent values as dollars in a donut legend — housing at
$285,000.00 against a host holding 285000 cents — beside one honest $4,243.11
total. The judge's note named the total, and the check audited **that** figure,
mis-added its six terms and convicted the one honest number on the screen while
the six fabrications sat in its own figures list: right verdict, wrong reasoning,
and one flipped sum away from clearing a screen that invented six figures. So the
judge's note is a **lead** now — it arrives after the question rather than ahead
of it, to be confirmed or replaced; every figure carries the words the screen
printed before it, because a bare `285,000.00` is nearly the datum itself; a
minor-unit value printed with a currency mark is *stated* to be an invented figure
rather than a mislabelled one, which the prompt had ruled out two paragraphs after
making units its own business; and the answer has a field for the arithmetic,
required and first, so it is written before the verdict rather than after it.

It can only make a screen's score better, never worse, which is why it needs no
retries and no blinding — nothing it is shown varies by who built the screen. The
figures come off the same settled DOM the judge read, deduplicated, in document
order and each under the words printed ahead of it, with the styles, the script
bodies and the entities taken out: a stylesheet is numbers all the way down and
displays none of them. That is
thirty-odd short figures on a real screen, so one call is pennies, and only a
screen the judge accused makes one — nought to four in a full corpus run.

Both verdicts stay on the record. `judged.honesty` in `result.json` holds the
judge's `fail`, its note verbatim, the check's verdict, its one-clause note, what
deciding it cost and the stamp that decided it (`HonestyContract`: the cheapest
Anthropic tier the meter prices, hashed prompt, pinned off the run's model table
like the judge and the liveness adjudicator). `summary.json` counts the flips per
column as `honesty.flipped`, because a flipped line is indistinguishable from a
pass the judge reached itself — the count is how much of that line's score was
the grader's noise, and a run where it climbs is a run whose judge is drifting.
The terminal says which way each one went beside the tally.

It grades **blind**. Nothing it is sent names the contender, its model or its
run folder; the SOURCE channel is the DOM the browser holds once the screen has
settled, script bodies dropped, captured when the shot is taken and the same for
every column — vendo's artifact is TSX and both baselines' is HTML and that is a
perfect classifier for which column is the vendor's, and the `page.html` that
first fixed that carries vendo's whole inlined runtime, which is more than a
judge's context can hold. The lines arrive shuffled and are mapped back
after, and the shuffle is **seeded from the case's own stamp**, so one case is
asked in one order — the same for every column of it and the same on every rerun.

The strike is on the **brand**, not on the word: `vendor`, `vendors`, `vendorId`
and `vendor_name` reach the judge as written. Striking them was a live scoring
bug — two of the fourteen worlds keep vendors, and every sentence about one
arrived as "host", in the screen AND in the tool data the honesty line is graded
against, so the judge compared a garbled screen with a garbled ground truth. It
is a blunt instrument either way, so the corpus is linted against it: no world
may say anything the strike rewrites (`worlds.test.ts`), which is what keeps a
future world from being graded against prose the harness edited.

And it is **symmetric**, or it is not blinding. `crayon` goes too: the thesys page
paints through that vendor's own UI kit, so `--crayon-*` and `.crayon-*` named
that column on sight in every one of its DOMs while both others were struck.
Unlike `vendor` nothing spares it — `crayon` is an ordinary English word, safe
only because no world says it — so a world that ever sells crayons has to spare
it in `judge.ts` first, and the corpus lint is what makes that a red test rather
than a silently garbled case.

Every verdict is `pass`, `fail` or `na`, and carries one clause naming the
evidence it was reached on. Each line arrives labelled `[correctness]` or
`[design]`, because only a DESIGN line may honestly be `na`: its subject may
genuinely be absent from this screen, so it is neither earned nor missed and sits
out of the tally. An ask line is what the case asked for, so a screen with
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
absent evidence is not a pass. Filling the text a locked control is waiting for
(2026-08-18) is a fourth, and the same kind: a screen whose submit is gated on a
typed reason used to record `pressed: 0` and fail the action case it correctly
implements, and now it is pressed and graded — while a screen whose field is
decoration is now pressed and can fail. Both directions, so no run recorded
before it compares with one after it. Three more probe fairness fixes landed under
that fourth heading the same day, and they move the same two directions. A
`<select>` is a control that gets pressed, by choosing an option it is not already
on, so a screen whose only actuator is `onChange` goes from `pressed: 0` and an
auto-failed action case to graded — and a chooser wired to nothing, or one whose
choice unlocks nothing a person could see, now fails where it was invisible. The
precondition pass leaves a chooser that already holds a real value alone, so a form
with a default fires the value it displays instead of the harness's overwrite: the
call in the trace changes, and with it the judge's reading of screens it used to
convict. And a control that was already the active one is recorded as a no-op by
design rather than as a dead one, so a screen that failed on the tab it opens on
passes. Every one of the three is the same code for every column. Guarding every
write (2026-08-18) is a fifth: the seam answers a write `pending-approval` and
approves it a tick later
instead of answering `ok` on the spot, so a page that shows what a write answered
shows something different, and the vendo column paints the product's own
"Waiting for your approval" notice where it used to paint nothing. No floor check
moved with it — the floor grades a call's name and arguments, which the guard
leaves alone — but the pages are not the same pages, so the break is stated with
the others. The sentence the writers are given caught up with it the same day:
`worldBlock` in `src/vendo.ts` now names the parked answer beside the other two,
so every prompt that describes the seam changed too — the same added bytes for
every column, which is what keeps them comparable with each other.

A select's own value moving is a sixth, the same day: the four numbers `Look`
already read are blind to a chooser whose selected option changed and nothing
else did — count, elements and `on` don't move on a value alone, and `text`
compares a LENGTH, which two different labels can share by coincidence — so a
screen that saves on choice, or one whose choice only unlocks a control further
down the page, read as `effect: "none"` on `project-tracker/file-bug` and
`trades-accounting/log-job-expense` alike. Every select's current value is read
and compared now, beside the other four, so a chooser the probe successfully
changes always registers as having moved, the same standing a checkbox or a
switch already had from its own `on` count. One direction only: this can only
turn a `none` the probe used to record into a `state`, never the other way, so no
run recorded before it compares with one after it.

Three grading bugs closed later on 2026-08-18, and each moves numbers. The
judge's identity strike no longer eats the word `vendor`, so every
`trades-accounting` and `property-management` case is graded on prose the harness
used to garble. A confirmation is credited only to the press that opened it, so a
screen convicted of a control it does not have is scored on what it really does.
And the rubric gained a paragraph — a note and a verdict that disagree are an
error, which was 11% of the honesty failures — so `rubricVersion` is **5** and no
verdict recorded under 4 compares with one after it.

Blinding `crayon` the same day is a fourth, and it lands on **one column**: every
`thesys` case before it was graded by a judge that could name that column from its
markup, and every one after it by a judge that cannot, so no `thesys` verdict
compares across that line. The other columns are untouched — nothing they emit
says `crayon` — which is the point: it was the asymmetry that was the bug. The
`pipeline` field arrived beside it and breaks nothing, being a recording rather
than a rule: no floor check, rubric line or exit code reads it. Its repair half is
still missing and needs a field on `ScreenOutcome`
(`packages/apps/src/contract/screen.ts`) — from out here the reviewer's verdict is
watchable and whether the repair round ran is not.

Two probe fairness fixes later on 2026-08-18 are a fifth and a sixth break, and
unlike the ones above the floor half of it moves in **one direction only**. Walking
the controls a press REVEALS in the page means an `action` case can now be proven by
a write one press inside an inline second step (`acted: "revealed"`), so a screen
that was correctly wired and simply unreachable — the probe stopping at the press
that opened the step — goes from a failed `actionProven` to a passed one. Nothing
can newly fail on it: a revealed control is not a binding, so one that does nothing
costs the screen nothing, and every column is walked by the same code. But traces
recorded before it carry no `revealed` paths at all and absent evidence has never
been a pass here, so an earlier run's `actionProven` still does not compare with a
later one's. The judge's reading moves in both directions on both fixes, because both
add evidence it did not have: the revealed paths, and `chose` — the trace now says
which values the HARNESS picked, which is what `project-tracker/sprint-board` needed
to stop losing the honesty line to a confirmation echoing the probe's own choice
back. `rubricVersion` stays **5**: the rubric and the prompt are untouched, and what
changed is what the trace tells the judge.

Two more probe fairness fixes land under that same heading, from the same run's
sweep, and they split the two directions between them. Walking into a **confirmation
a revealed press opened** extends the reveal walk by exactly one level, so an
`action` case can now be proven by a write two presses inside an inline step — the
`capacity-rebalance` shape, where *Hand off* reveals a *Confirm* and *Confirm* opens
the Modal that calls the tool. It moves the floor in **one direction only**, for
`revealed`'s reason: those paths are not bindings, so nothing new can fail on them.
Answering a required **number** box (`input[type=number]`, with the digit `3`) moves
it in **both**, exactly as filling a text box did: a screen whose submit is gated on
an estimate used to record the choices around it and never the press, and is pressed
and graded now — while a number field that is decoration is now pressed and can
fail. Re-probing the saved pages of the run that found them flips exactly the two
cases named and leaves the other 376 verdicts identical, `team-permissions` — whose
one control really is a local filter — included. Both are the same code for every
column, and both are the same kind of break as the fixes above them: a trace
recorded before them carries neither the nested paths nor the filled number, and
absent evidence has never been a pass here, so no earlier run's `actionProven`
compares with a later one's. The judge's reading moves with them too, because the
confirmation a revealed press opened is now narrated to it in the words a person
reads off the dialog. And later the same day the judge started seeing what
**scrolling** reveals: a table wider than the 1280px frame is shot again at its full
scroll width, up to three per screen, and shown beside the viewport shot as what it
is — so the columns past the horizontal fold, which cost three style lines a
convention they were keeping the whole time, are evidence rather than absence. The
viewport shot is still the primary one and the floor is untouched, but the rubric
gained the sentence that names those pictures, so `rubricVersion` is **7** and no
verdict recorded under an earlier one compares with one after it.

Then the **answers** stopped being trusted to arrive in order. On
`trades-accounting/quote-options` two ADJACENT slots came back traded: the honesty
line, asked in slot 12, was stamped `na` on a note about press traces, and the
destructive-confirmation line asked in slot 11 was cleared on a note about
figures — each line graded against its neighbour's evidence, both notes competent
sentences about the wrong thing, and a mapper reading answers by their place in the
list could not tell. So every verdict now opens with the checklist number it
answers and is mapped home by that number, not by where it sits; and a set of
numbers that is not every line exactly once is **refused** — the screen is asked
again and then degraded, rather than graded by laying the answers over the rubric
in order. `rubricVersion` is **8**.

The **worlds** were then audited against their own tools, and that batch moves
stamps rather than code. Three cases asked for a picture nothing here can draw —
`logistics/driver-map`, `product-analytics/active-users-map` and
`observability/service-map`, each graded on a map or a node graph while its own
pass lines banned the buildable alternative — and are gone, so the corpus is
**196 cases**. Twelve more pass lines demanded a figure the prompt never asked
for (a week's on-time rate, a per-terminal revenue column, a month total) or
graded a wizard step the same case tells the screen not to show yet, and are cut;
thirty-two are reworded to grade what a screen can actually do — a row's own
control rather than a click on the row, a region table rather than a map,
indented nesting rather than a drawn tree — and one is split in two so a layout
and a sum stop failing together. Eleven style rubrics moved with them: the
`trades-accounting` money line is three lines now, the three confirmation worlds
name the actions that genuinely cannot be undone and say the host's own approval
step counts as the confirmation, and the two dense-operator worlds stopped
forbidding the headline figure their own wall-board case asks for. Two worlds'
tools moved too — `property-management`'s showings carry a full
`2026-08-13T17:00` stamp instead of a date beside a bare time, and
`product-analytics`'s daily-activity tool now says plainly that it answers with
the same fourteen days whatever `days` asks for. Every edited case's `caseHash`
moves and every edited world's `world` hash moves, which is what those two stamps
are for: the 38 surviving cases that were edited do not compare across this line,
and the other 158 still compare with each other.

The frame those pictures are taken in widened from **480px to 1280px** in the
same batch. That moves the screenshots the judge reads for every column at once,
so no verdict shot at 480 compares with one shot at 1280.

Three fixes off the **2026-08-18T21-39-10** sweep close the last of that batch, and
they split three ways. A press that moved the screen now says WHAT it put there, so
the trace stops reading like a dead control: `trades-accounting/price-book` lost
three correctness lines to "the HVAC and Electrical tabs are inert per the trace",
against a trace saying `changed: true` for both — the rows behind those tabs, the
$42.00 spiral duct and the $3,850.00 panel among them, are on the trace now. It
moves the JUDGE in both directions and no floor check reads it. A chooser that
never took the harness's value is `choice-dropped` rather than a dead control,
which moves the floor in **one direction only**: it was the sweep's single floor
failure (`project-tracker/open-issues`'s first of two choosers, on a correctly wired
screen whose second chooser took its value fine one reload later), and the retry
means most such presses now land instead of being excused. And a required argument
sent **empty** is invalid, which moves the floor in **both**: `move_issue({issue_id:
"CAI-142", status:""})` was stamped `argsValid: true` on
`project-tracker/my-issues-inbox`, so the judge failed the line while the floor
cleared the screen — that one status control now fails `wired` and the five beside
it, which send real statuses, still pass and still prove the case's action. All
three are the same code for every column. `rubricVersion` is untouched — the rubric
and the prompt did not move, only what the trace tells the judge and what the floor
does with an empty slot — but a trace recorded before them carries neither the
revealed words nor the checked choice, so no earlier run's `wired` or `pressed`
compares with a later one's.

The probe presses one control per fresh page, so a screen with many controls
costs many reloads — the choosers among them included, which is what a table of
nine of them costs now — and a locked control costs one pass over the screen's
unanswered selects and empty boxes on top of its reload. A dialog costs one
full walk back to it per control inside it, on top of that. That pass is the only
precondition the probe satisfies — a choice a `<select>` is asking for, and a value a
text or number box is empty of — so a control guarded behind a ticked box, a *date*
or an *amount* neither sentinel is, or an earlier step stays unpressed and ungraded. A chooser that is
only ever a precondition is pressed on its own page all the same, and it holds by
unlocking something a person could press; where it guards a control that needs a
second condition as well, it unlocks nothing visible and is recorded as a control
that did nothing. The pass runs before the press that opens a dialog and never
inside one, so a control locked behind a field in the dialog itself is still
recorded as unproven. An inline step costs one press per control it revealed, and
those are the cheapest presses the probe makes — they share the page the opening
press left standing rather than reloading for each — but a screen where every row
reveals a small form pays for all of them. Multi-step flows are followed
exactly one dialog deep: a confirmation that opens a second confirmation is
recorded as a press that changed the screen, and nothing inside the second one is
pressed. A reveal reaches one press further — the confirmation at the end of an
inline form is walked, so the depth is reveal then dialog — and there it stops for
the same reason, a dialog inside that dialog being recorded and not entered. A reveal
is also one PASS as well as one level: the controls it revealed are pressed in
document order, so a step whose dismiss sits before its confirm loses the confirm,
and a control that only appears after two of them are answered is never reached. And
a reveal whose confirmation is walked pays for it: each way out of that dialog costs
the whole step replayed from a fresh page, so a table of rows that each reveal a
confirmed form is the most expensive screen the probe meets. A step the screen keeps in the
markup and merely un-hides is not a reveal either — identity is what a control is
and says, not whether it is laid out — so those controls are pressed as controls of
the screen, from the page's first count, exactly as they were before. A control that navigates off the screen — a link with an `href` — is
recorded as having gone somewhere and called nothing, which is the only thing that
can be read once `window.vendo` has left with the page.

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

`buildlog`'s `get_build_stages` and `get_build_log` ignore `build_id`: one static
fixture answers every build, always build 4188's. Nothing in the world format
lets a tool's canned data vary by argument (`cannedResponse` in `src/world.ts`
returns `tool.data` untouched), so the fix is documentation, not data — each
tool's `does` now says plainly that it never varies and to only ask about build
4188, which is what both cases that call them already do. A new `world.hash`,
so `buildlog` runs from before this fix do not compare with ones after it.
