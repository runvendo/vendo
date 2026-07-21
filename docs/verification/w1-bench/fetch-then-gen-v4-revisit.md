# Fetch-then-generate, revisited under the v4 create contract (2026-07-21)

Re-run of the W1 Experiment 3 lever (`VERDICTS.md` §Experiment 3, verdict
DEFER) with **both arms on the v4 create contract** (`pipeline.promptRewrite`,
merged #462). The old verdict was measured against the pre-v4 contract; its
two load-bearing facts were (a) binding errors drop to 0.00 when the model
sees real data, and (b) compile-ok regresses 100%→81%, concentrated in
negative prompts drifting to prose refusals. This run answers whether either
fact survives the contract change — and adds the metric the 2026-07-21 final
gate said now matters most: **label-truth** (headlines/labels contradicting
the data beneath them, the dominant remaining fail class).

Harness: `packages/apps/src/bench/exp5-fetch-v4.bench.test.ts`. Raw
per-sample records: `raw/exp5-fetch-v4.json`.

## Method

- **Contract:** both arms use the engine's own `wireContractV4(deps)`
  (single-shot: no structured repair, no end pass, no paint lane — the lever
  is isolated). Deps-level composition only; zero engine changes.
- **Host:** the Maple bench fixture host (`fixtures.ts`) — same tools/shapes
  as exp1–3, plus input-schema sketches so HOST TOOLS reads like production.
  Empty host catalog: the Kit is the component surface (the v4 prompt teaches
  the Kit; the exp1–3 fixture catalog was a Kit subset).
- **Arm A (blind):** today's path — shape cards only.
- **Arm B (fetch-then-generate):** phase-1 no-think read-planner picks read
  tools + args → the runtime "executes" them (fixture samples, arrays trimmed
  to 2 rows + the TRUE rowCount) → the generation prompt carries the data
  digest in the user turn ("bind these exact fields, make every claim true of
  this data").
- **Prompts:** 10 authored fresh for this run and burned to the GOLDEN.md DEV
  list (D7–D16): 8 positives baiting the headline/superlative/period-claim
  fail class, 2 negatives (no tool for the ask — exp3's compile-regression
  trigger). 2 attempts per prompt per arm → n=20/arm.
- **Models:** generator `claude-sonnet-4-6`, judge `claude-opus-4-8`
  (blind to arm), same as W1.
- **Metrics:** production compiler verdicts (`compileWireV2` with the
  production options: `inlineRefs` + `inlineTools` + shapes); label-truth
  judged by opus against the GROUND-TRUTH tool data (the fixture samples are
  what the tools return). Latency for arm B is honest: the serialized phase-1
  call is charged to every attempt; its tokens are charged too.
- **API spend:** 40 generation + 10 planner + 20 judge calls.

Deviations to know before comparing numbers elsewhere: generation ran at the
bench client's default temperature (not the engine's temp 0); phase-1 ran
once per prompt and was shared by that prompt's two arm-B attempts; one blind
sample died on a transport error (excluded from rates, counted in
genErrorRate).

## Results

All samples (10 prompts × 2 attempts; negatives included):

| arm | n | gen-err | compile-ok | ref-error-free | mean binding-err | mean label-truth-err | label-truth-clean | fabrication | mean quality (sd) | p50 total | mean total | mean tokens in/out |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A: blind (v4) | 20 | 5% | **100%** | 79% | 0.11 | 1.47 | 32% | 0% | 3.53 (0.94) | 9.2s | 11.3s | 8358 / 815 |
| B: fetch (v4) | 20 | 0% | **100%** | 85% | 0.15 | 1.00 | 35% | 0% | 3.95 (0.80) | 11.4s | 14.1s | 8851 / 941 |

Quality diff (B−A): **+0.42 ± 0.56** — not outside noise.
Label-truth diff (B−A): **−0.47 ± 0.77** errors/app — not outside noise.

Negatives (2 prompts × 2 attempts): **both arms 4/4 compile-ok, 4/4 honest
Disclaimers, 0 fabrication.** The exp3 blocker — an empty fetched block
drifting the model into a prose refusal — did not occur once under v4.

### Where the errors actually are

**Binding-shape errors are no longer the story.** v4 blind is already near
zero (0.11/app vs 0.57 on the old contract), so the 0.00-binding-errors win
that made exp3 worth deferring-not-rejecting has nothing left to win. The
residual errors in BOTH arms are a different class — wanting a computation
the dialect forbids (`.length` on an array, an invented `count` field when no
count exists). Seeing real data does not fix "there is no field for what the
label wants to say"; 5 of 6 residual binding errors are that.

**Label-truth is the story, and fetch moves it — by class:**

| lie class (judge-flagged) | blind (n=19) | fetch (n=20) |
|---|---|---|
| out-of-bounds index / nonexistent field claim (e.g. "latest month" bound to `data.5` of a 3-row array) | 6 | 3 |
| row-count claims ("trailing 6 months" heading over 3 rows, counts that don't match) | 10 | 4 |
| scope/aggregation lies ("Total cash" over one account, wrong-total headline) | ~12 | ~13 |
| **total label-truth errors** | **28** | **20** |

Fetch-then-generate cuts exactly the classes where the lie is *ignorance of
the actual data* — the model saw rowCount 3 and stopped writing "6 months",
stopped binding `data.5`. It does NOT cut the scope/aggregation class, where
the lie is *wanting an aggregate no tool provides* ("total cash" when
`accounts.list` has no sum field) — that is label-wording discipline (the
v4 principle "change the words, not the data") or an end-pass job, and data
in the prompt doesn't change it.

Two judge flags against the fetch arm are fixture artifacts, not model
errors: the fixture's static `invoices.list` sample ignores the
`{status:"overdue"}` filter (returns 2 overdue + 1 sent row, `totalCents`
over all 3), so the model faithfully binding "what the tool returned" got
flagged for including the sent invoice. A live host returns actually-filtered
rows. Net of those, the fetch arm's label-truth mean drops ~0.2 further.

### The honest cost

- **Latency:** +2.8s mean (+2.2s p50) end-to-end. ~1.5s is the serialized
  phase-1 planner; ~1.3s is the longer phase-2 prompt/output. Note the
  production pipeline has a place to hide the planner: it can run concurrent
  with the tier-0 paint lane, which already fills the first seconds.
- **Tokens:** +493 input, +126 output per app (planner + digest + slightly
  richer apps).

## Verdict

**Still DEFER by the letter of the W1 adopt rule (nothing is outside noise at
n=20) — but upgraded from "shelved" to ADOPT-CANDIDATE: every disqualifier is
gone and every measured axis now favors it.**

- The compile regression that drove the exp3 DEFER is **gone**: 100%
  compile-ok both arms, negatives 4/4 honest Disclaimers under v4.
- The binding-error elimination that made it worth keeping is **also gone** —
  v4 already banked that win (0.11/app blind).
- What's left is the reason the lever matters *now*: it is the only mechanism
  measured so far that reduces the final gate's dominant fail class at the
  source, cutting the data-ignorance lie classes roughly in half
  (out-of-bounds 6→3, row-count claims 10→4) and reading +0.42 on quality —
  consistent direction, under the significance bar, at a real +2–3s cost.

**Revisit conditions (any one):**

1. **The next live browser gate runs it as an arm.** n=20 offline cannot
   resolve a −0.47 ± 0.77 label-truth effect; 30 browser-judged prompts can.
   Adopt if the label-truth/headline fail class drops there without a
   latency-budget breach.
2. **The planner is made free** — fused into the paint lane's wall time or
   emitted by the same call that outlines regions — removing the serialized
   +1.5s, at which point the remaining cost is ~500 input tokens and the
   trade is one-sided.
3. **Scoped adoption:** data-dense/summary asks only (digest for list/summary
   read tools), where the row-count and out-of-bounds classes concentrate.

What fetch does NOT fix — scope/aggregation label lies ("total" over one
account) — should be attacked by the end pass (its priority-one contract is
exactly this) or a label-wording validator, not by this lever.

## Reproduce

```
ANTHROPIC_API_KEY=... pnpm --filter @vendoai/apps exec vitest run src/bench/exp5-fetch-v4.bench.test.ts
```

Raw: `docs/verification/w1-bench/raw/exp5-fetch-v4.json` (per-sample wires,
compiler verdicts, judge verdicts, planner reads, timing, tokens).
