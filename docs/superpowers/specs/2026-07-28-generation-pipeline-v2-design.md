# Generation pipeline v2 — one brain, blinkered workers, apps edited like files

**Date:** 2026-07-28 · **Status:** design agreed in brainstorm (Yousef, 2026-07-28);
awaiting written-spec sign-off. Nothing builds before that.
**Relation to the 2026-07-27 spec:** supersedes D2 (pass decomposition) and
D4 (pipeline combinatorics) with a concrete architecture; sharpens D3 (prompt
diet). D1 (composite vocabulary, ~10, mockups pending) and D5 (capability-
substitution gate, shipped) stand unchanged, as do the OSS ruling and the
frozen persisted format.

## Why (short version — evidence lives in the 2026-07-27 spec)

The current pipeline enforces by prose what should be enforced by structure,
and it accumulated nine mechanisms behind seven flags (128 possible
pipelines): a regex judge routing natural language, a throwaway paint lane, an
unresolved region-parallel A/B, four overlapping repair subsystems, an
8,300-token contract whose key rules the model ignores. Measured: 31% island
apps, p90 island share 93%, 9% of apps reaching mutating tools from islands,
p90 latency 103s. The complexity is not neutral; it makes the product worse.

## Laws

Every decision below follows from six laws. When in doubt during
implementation, the laws win.

1. **The model's world is plain text; the machine's bookkeeping is
   invisible.** Models read and write wire text like a file. Ids, hashes,
   manifests live compiler-side and never spend a token.
2. **Structure enforces; prose only carries what no validator can check.**
   Wrong answers should be unwritable (schema, vocabulary, grammar) before
   they are detectable (validator), before they are discouraged (prompt).
3. **Thinking is never thrown over a wall.** Whoever thought about a problem
   either finishes the job on the spot (small work) or writes the spec for
   workers (big work). Nobody re-derives a decision someone else already made
   — and nobody pre-guesses a decision that belongs to a deeper thinker (the
   sandbox agent specs its own interface).
4. **Bind against reality.** UI binds to data shapes at the moment they are
   real: host tool shapes at plan time, sandbox shapes when the sandbox
   finishes. Nothing is built against a guess.
5. **Measured, not argued.** Every open dial is settled on the genui-bench
   corpus with held-out prompts (the v2 anti-overfitting law carries over).
   No unresolved A/B survives in the codebase.
6. **Readable like a human wrote it.** Every prompt fits on one screen and
   reads like a senior engineer wrote it for a new hire. Every validator
   message is one sentence a human would say. A rule that can't be stated in
   one sentence is a heuristic wearing a rule costume — delete it.

## The cast

| Actor | Model | Memory | Job |
| --- | --- | --- | --- |
| **Brain** | big, thinking (adaptive) | one ongoing session per app | reads every instruction; does tiny work directly, plans normal work, refuses impossible work honestly |
| **Workers** | fast, no thinking | none | one per group; transcribe the plan into props and bindings, in parallel, blinkered to their group + its query samples |
| **Specialists** | big | none | island writer (custom TSX), automation planner, sandbox agent — hired only when the plan asks |
| **Plain code** | — | — | skeleton renderer, compiler, validator, query runner: instant, deterministic, free |

## Create

```
instruction ─► BRAIN (thinks as much as the ask needs)
                 ├─ tiny ask   → writes the finished app in the same response
                 ├─ impossible → honest refusal via the cannot path (~2s)
                 └─ normal     → emits a <Plan>
                                   ├─► skeleton on screen (~4s, deterministic)
                                   ├─► queries start executing on the host
                                   ├─► fill workers, one per group, parallel
                                   ├─► island / automation / sandbox passes,
                                   │     only if planned
                                   ▼
                                 validate → fix-it edits → live
```

**The direct path.** If the app is trivially small, the brain writes it
directly — one call, ~4–5s total. The guard is structural: the direct
output's vocabulary has no islands and no server ops, and the validator
rejects a direct emission larger than one group / ~5 leaves with "too big —
emit a plan" (a ~1s retry). The escape is only as big as the apps that never
needed a plan.

**The plan** is spoken in a tiny wire dialect (text — it streams, it thinks
freely, and it is what the model natively speaks), validated mechanically in
microseconds (composites exist, tools exist, referenced queries declared,
schedules parse), retried in ~1s on failure. A strict-JSON tool call is the
documented fallback if text plans misbehave in practice; a one-day swap,
bench-arbitrated.

```xml
<Plan name="Invoices Workspace">
  <Query id="totals"   tool="host_invoiceTotals"/>
  <Query id="invoices" tool="host_listInvoices" input={{status:"overdue"}}/>
  <Tabs>
    <Tab title="Overview">
      <Group title="Health" layout="grid" columns="2">
        <Leaf composite="MetricRow" query="totals"   purpose="totals, overdue count"/>
        <Leaf composite="Chart"     query="invoices" purpose="overdue by month"/>
      </Group>
    </Tab>
    <Tab title="Payments">…</Tab>
  </Tabs>
  <Server kind="steps" schedule="fridays" why="chase reminder"/>
</Plan>
```

**Three fixed structural levels, no recursion:** containers navigate (Tabs,
Pages, Wizard), groups cohere (a titled region with a layout), leaves render
(one composite). Each level's grammar simply lacks the fields to go deeper —
depth violations are unwritable, not forbidden. Visual sub-arrangement inside
a group is attributes (`col`, `row`, `span`), never structure: the group is
already the single-worker unit, so internal structure would add bookkeeping
without capability. Queries are declared once at plan level and referenced by
leaves, so shared queries execute once.

**Skeleton.** Deterministic code renders the plan as the real final layout
with placeholders — containers (tab bars, page nav) are plan-authored chrome
that never meets a model again. Streams progressively as the plan emits.
Replaces the paint lane outright, including its "never a white box" job: any
later failure leaves an explainable surface, never a blank.

**Fill.** One fast no-think call per **group** — the group is both the
coherence boundary (its leaves must tell one story, so one mind writes them
together) and the job boundary (groups only need non-duplication, which the
plan's `purpose` lines already divide). Plan schema caps a group at ~5
leaves: bigger asks force the brain to decide the coherence boundaries.
Workers see only: app name/purpose, their group, their referenced queries'
shapes plus live sample rows, their composites' contracts. They emit id-free
wire fragments that the compiler slots into the skeleton. Visible-tab groups
fill first; hidden tabs in the background. Concurrency is a **number, not a
mode** — ship at 1–2, bench turns it up; there is no serial pipeline and no
parallel pipeline.

**Escapes are earned.** The fill vocabulary contains no islands and no server
ops — deviation is unwritable. Custom UI exists only because the plan
declared it, on the brain's three-step ladder: composites → island (one
custom component inside a normal app) → served app (the whole interaction
model is custom).

## The sandbox (experimental, flags unchanged)

Layer 2 — sandbox as the app's backend — is the workhorse: the app's face
stays a normal Vendo app; the sandbox supplies `fn:` queries the host can't
compute. Per law 3 and law 4, the plan declares **intent only** (`<Server
why="fuzzy dedupe"/>` plus which sections depend on it) — never a guessed
signature. Independent sections fill immediately; dependent sections show
"building server logic…"; the sandbox agent builds with full freedom, then
reports its real interface with sampled shapes; dependent groups fill once,
against truth. Today's 3-attempt fn-rebind ceremony and the bespoke
`graduate()` choreography stop existing — graduating an existing app is just
an edit whose plan amendment includes server work.

Layer 3 — served app — is the brain's last resort for interaction models
composites and islands can't express. Same mechanics as today (double flag,
serve check, egress approval, tree/pins deleted on flip). Edits to a served
app are instructions to the sandbox agent, still through the same brain
session. Flag gating moves to the honest place: the brain knows the host's
flags, so a sandbox-shaped ask on an unflagged host gets the `cannot` path in
~2s, never a late throw.

Automations keep today's model wholesale: trigger on the app document
(lifecycle free), grants as the approval surface, results collection as the
logbook, results bound into the tree as a normal query. A generated
automation always has an app as its home — for a pure-automation ask the
minimal app (logbook + switch) *is* the deliverable. No invisible robots.

## Edit

One lane. Every instruction on an existing app goes to the same brain
session, which remembers the create, the plan, and every prior turn — so
referential asks ("no, the *other* chart") resolve, and nothing re-derives
intent. The brain's output decides:

- **Small ask** → it emits string edits directly: `old` (exact text, must
  match once) / `new`, applied deterministically, recompiled, validated.
  ~2–3s.
- **Structural ask** → it emits a plan amendment itself (it already did the
  thinking), the skeleton grows, fill workers run for the new parts only.

The plan is **disposable scaffolding**: after creation the app text is the
only truth; the plan is never kept in sync. Sessions are trimmed (keep the
plan and recent turns, summarize ancient ones; current app text always
presented fresh) and ride prompt caching as an ever-growing stable prefix.

**Identity without visible ids.** The model-facing text carries no ids.
Compiler-internal ids (React keys, skeleton slots) are minted at compile time
and carried across edits by the replacement span: text outside the span keeps
its identity, text inside gets fresh identity — deterministic, zero
heuristics, exactly because edits are content-anchored replacements. Pins
were always name-anchored and are unaffected. Human-facing diffs are git-style
text diffs of the wire. The rare full-rewrite (re-plan) remounts once, on a
path where everything genuinely changed.

## Validate and repair

Six always-on checks, each one sentence:

1. **Compile** — does it parse.
2. **Plan check** — do the named tools, composites, and schedules exist
   (runs at plan time, microseconds).
3. **Schema** — does each fragment satisfy its composite's typed schema
   (this one check replaces today's binding-kind, Kit-slot, reshape, and
   catalog-prop validators).
4. **Law 1** — data comes from a query, never typed in.
5. **Law 2** — buttons do something real.
6. **D5** — a mutating tool is never repurposed for a missing capability
   (shipped, unchanged).

The island gauntlet (imports, network, tool scan, smoke render) survives
unchanged but relocates into the island specialist's rare lane. Deleted
outright: the empty-document heuristic (the plan is the judgment; honesty
comes from `cannot` + disclaimers), rooted-render (skeleton slots make
orphans unwritable), interpolation and query-input rules (grammar-level
rejections, not validators).

**Repair is not a subsystem.** Issues become a machine-written instruction to
the same edit mechanism: fix-it string edits (fast model, ×2), then back to
the brain (re-plan) — the only full restart, reserved for "the app misread
the ask." The strict fix menu is **cut**; it earns its way back only if the
bench shows string-edit repair loops on the cheat class (hand-typing data
instead of fixing a binding). Every validator message is written as teaching:
"this Table binds a field that doesn't exist in host_invoices — real fields
are: …".

## Prompts

Triage every rule: enforced by a validator → delete from the prompt (the
fix-it edit teaches it in context, attached to the actual violation); not
enforced but load-bearing → enforce it or show a worked example; neither →
delete. Per-actor budgets:

| Prompt | Contains | Target |
| --- | --- | --- |
| brain | plan dialect, composite names + one-liners, host tools, the few unvalidatable judgment rules | ~1.5–2k tokens |
| worker | its group, its queries' shapes + samples, its composites' props, binding syntax | ~0.5–0.8k |
| island specialist | island rules (out of everyone else's world) | ~1k, rare |
| edit turn | app text + instruction (session carries the rest) | tiny |

Categories that vanish rather than shrink: island rules in the main contract,
id discipline, the `<Edit>` ops dialect, whole-app-in-an-island warnings,
budget/retry warnings. The old spec's ≤4k target becomes an outcome, not a
goal.

## Efficiency

Latency ≈ tokens emitted; cost ≈ tokens processed. Emit less, cache more,
overlap more:

1. **Smart composite defaults** — a Table infers sensible columns from the
   query shape; workers write one line and spend tokens only on overrides.
   Moves work from generation (slow, fallible) into the composite (built
   once, deterministic).
2. **Byte-identical worker prefixes** — contract + catalog + app context
   shared across all workers hits the prompt cache; workers 2..N pay only
   their unique tail. Parallel fill costs barely more than serial.
3. **Fill starts while the plan streams** — a group's job launches when its
   plan lines complete, not when the plan ends.
4. **Build-time query results kept for first open** (short TTL) — the first
   view renders with data already in it.
5. **Edit sessions ride the cache** — the conversation is a stable prefix;
   edit #2 onward pays tokens only for the new instruction and diff.
6. **Model prewarm** on request start (exists today; keep).

Rejected: cross-user plan caching (correctness minefield to save 300 tokens).

## What dies / what survives

| Dies | Replaced by |
| --- | --- |
| regex escalation judge + carve-outs | the brain's plan (routing as an AI output, zero extra calls) |
| paint lane + monotonic-partial gate | skeleton from plan |
| region-parallel topology + outline | plan + concurrency dial |
| inline islands in the main contract | plan-earned island pass |
| island-repair budget, free-form retry channel, end pass, rebind pass | fix-it string edits + re-plan |
| strict fix menu | cut; bench can resurrect |
| `<Edit>` ops grammar + patch compiler | old/new string edits |
| visible ids in model-facing text | compiler-internal ids via replacement spans |
| `graduate()` + 3-attempt fn-rebind | intent-only `<Server>`, bind-after-build |
| empty-document heuristic, rooted-render, 4 prop-type validators | schema check + unwritable-by-construction |
| 7 flags / 128 pipelines | one pipeline; dials are numbers with bench-set values |
| 8,300-token contract | per-actor prompts on the readability law |

Survives untouched: the JSON tree at rest (format tag frozen; every existing
customer app renders), validator laws 1/2/D5, island sandbox + smoke render,
box/machine adapters and served-flip mechanics, automations engine + grants +
results collections, in-client approval, pins/drift/rebase (rebase replay now
rides string edits), history/undo, Cloud/BYO adapter rules.

## Non-UI use cases (checked against the design)

One-off tool calls ("create an invoice for X") — the embedded agent's job,
approval-gated, no app, no pipeline. Standing business rules — automation
lane, minimal app as home. Deep custom logic — layer 2 sandbox. The plan
dialect makes near-zero-UI apps first-class; no validator penalizes them.

## Success criteria (hard gates, carried over)

| metric | baseline | target |
| --- | --- | --- |
| failure rate | 7% | ≤ 7% — never worse |
| apps with island ratio > 0.6 | 30% | < 10% |
| island reaches mutating tool | 9% | 0% |
| contract static tokens | ~8,300 | ≤ 4,000 (expect well under) |
| duration p50 / p90 | 16.1s / 103.3s | ≤ baseline; p90 is the primary target |

Plus new: time-to-real-layout ≤ 5s p50 (the skeleton promise).

## Open dials (bench decides; nothing ships as an unresolved A/B)

1. Fill concurrency (ship 1–2, turn up).
2. Queries-during-build on/off.
3. Fill model tier (fast vs big-no-think).
4. Strict menu resurrection (only if string-edit repair loops).
5. Plan dialect: wire-text vs strict-JSON fallback.
6. Plan thinking budget cap.

Method: one-prompt smoke test the day a dial lands; verdicts only from the
recorded corpus with held-out prompts.

## Risks

- **The plan is the new ceiling.** A plan that misreads the ask builds a
  confidently wrong app. Mitigations: plan validation is mechanical and a
  retry costs ~1s; the skeleton makes a wrong plan visible at ~4s, not after
  a 40s generation.
- **Every non-trivial create pays the plan call** (~4–7s to skeleton; 4s is
  the optimistic end). Bought back by no-think fill, parallelism, and far
  fewer retries; the direct path exempts trivial asks entirely.
- **Scope.** This rebuilds the engine's front half; the back half
  (validators' survivors, sandbox, automations, persistence) carries over.
  Delivery is sliced but every slice is the end-state shape — no stopgap
  modes built to be deleted.
- **Fill-without-thinking quality** is an assumption backed by the paint
  lane's track record, not yet by the bench; dial 3 exists because the
  assumption might be wrong.

## Decision log (Yousef, 2026-07-27 → 28)

Greenfield scope (old spec = evidence, not law) · islands earned via a
second pass · plan-then-fill with the direct path · think once at the plan;
workers no-think · parallel-by-construction, concurrency is a number ·
three-level plan (container/group/leaf), group = fill unit, attributes
arrange · plan spoken in wire-text · edits ride one per-app brain session;
the brain plans or does, never hands off · repair = edits, apps edited like
files (old/new strings), no ops grammar · no visible ids; git-style diffs ·
validators cut to six; empty-document rule deleted · prompts on the
readability law · automations/approvals/results collections unchanged ·
sandbox layer 2: intent-only plan, bind-after-build · layer 3 unchanged,
last-resort, same flags.
