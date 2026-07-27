# KNOWLEDGE — the knowledge eval

Status: ACTIVE since 2026-07-25 (lane K2 of the knowledge block design —
signed spec `2026-07-24-knowledge-block-design.md`, §Evals). This is the
quality gate for
everything the knowledge block does: retrieval, grounded answers, honest
refusals. If you are about to measure, improve, or make claims about knowledge
quality, start here.

## The pieces

| Piece | Where | What it is |
|---|---|---|
| Golden set (~60 Q&A) | [`knowledge/golden.json`](./knowledge/golden.json) | Hand-curated questions with expected source doc ids AND answer key points, covering all three kinds (docs/glossary/api) and all three intents (chat/deep/schema) |
| Refusal set (15 + paraphrases) | [`knowledge/refusals.json`](./knowledge/refusals.json) | Questions with NO answer in the corpus; ANY non-refusal outcome is a hard failure — a red run, never a score |
| Per-engine pass bars | [`knowledge/bars/<engine>.json`](./knowledge/bars/) | Ratcheted metric floors per engine (see "Bars" below) |
| Fixture corpus | `corpus/harness/src/knowledge-eval/fixtures/corpus.json` | 59 `KnowledgeDoc`s derived from `docs-site/*.mdx` (reference/* → kind `api`, rest `docs`), 12 synthesized glossary entries, 4 `visibility:"internal"` docs from `docs/*.md` |
| Runner + metrics + judge | `corpus/harness/src/knowledge-eval/` | `pnpm corpus knowledge-eval [--engine memory]... [--json] [--strict]` — recall@5 + MRR per intent, refusal leg, bars check, scorecard artifacts; repeat `--engine` for the per-engine comparison (engine columns); `judge.ts` is the shared LLM-judge surface |
| Per-PR CI gate | `.github/workflows/knowledge-eval.yml` | The deterministic offline run, strict, on every PR and push to main |

Doc ids in the fixture corpus are content-derived slugs (from frontmatter
titles), never docs-site file paths — file paths rot (corpus/README.md once
pointed at a deleted `docs-site/install.mdx`); slugs survive moves.

## What is frozen, and the per-PR carve-out

The front door's frozen-set law ([GOLDEN.md](./GOLDEN.md)) exists to protect
model-judged numbers from tuning contamination. It applies to the
**model-costed parts only**:

- **Frozen (never tuned against, run nightly/on-demand):** LLM-judge answer
  metrics (faithfulness, citation correctness, completeness) and every
  live-engine run (cloud, and local/lexical once lane K7 lands). Do not quote
  a fail from these legs in a fix PR without burning the item (GOLDEN.md
  rule 4 applies).
- **Per-PR, strict, deterministic (the carve-out):** retrieval metrics against
  expected doc ids, refusal mechanics, schema validation, referential
  integrity, and judge plumbing exercised with scripted (canned) judgements.
  These legs never call a model — mirroring corpus/README.md's posture that
  model-costed runs are "never part of `pnpm test`" — so tuning is not a
  concept that applies; they run on every PR and block merge.

The memory engine's whole run is deterministic (its `memoryQuery` values are
authored, not discovered), so the entire memory leg is per-PR.

## Bars: how they ratchet

`bars/<engine>.json` carries metric floors with the same semantics as the
corpus layer-2 `baseline.json` files and `bench/budgets.json`:

- A run compares every bar key against the metric it measured; any measured
  value below its bar is check `bars.regression` — a hard failure under
  `--strict`.
- Bars only move via a PR editing the file, with the justification appended to
  `toleranceRationale` (one line: what changed and why).
- Bar keys the run did not measure (e.g. `judge.*` on an offline run) are
  reported loudly in a `bars.skipped` check — never silently ignored.

## How an engine joins the matrix

Engines are discovered by **bars-file presence**: the runner takes any engine
as an injected `KnowledgeAdapter`, and `bars/<engine>.json` existing means
that engine is in the matrix. Joining is two small changes, zero runner
rewrites:

1. Add the engine's case to the registry in
   `corpus/harness/src/knowledge-eval/engines.ts` (how to construct its
   adapter; live engines read their credentials from env and must fail fast
   without them).
2. Calibrate and commit `bars/<engine>.json` from its first honest run.

In the matrix: `memory` (per-PR CI) · `lexical` (joined 2026-07-26 at K7
landing; deterministic over an in-memory store, but NOT in the per-PR
workflow — its refusal layer is red at baseline, see the ledger). Planned:
`cloud` (lane K3, nightly). Real engines are measured on the natural
`question`; only the memory engine uses `memoryQuery`.

## Nightly engine-matrix rows (not per-PR; wiring lands with the engines)

These rows run `pnpm corpus knowledge-eval --engine <e> --strict --json` plus
the model-costed judge leg, one row per engine with bars. They belong in the
nightly workflow, NOT in `knowledge-eval.yml` (a separate wave owns
nightly.yml; the runner already accepts `--engine`, so wiring is one line per
engine when K3/K7 land). **Anti-silent-skip idiom:** a nightly row that cannot
run (missing key, engine unreachable) must FAIL its job step with the reason
in the step summary — a skipped engine that looks green is how quality rots.
The same idiom governs test-level skips: gated suites announce the skip
reason in output (see `tool-legs.test.ts`).

End-to-end scenarios that need lanes K3/K4 (connect a fixture docs site →
sync → grounded answer with citation chip; mutate → re-sync → answer changes
with sync-to-answer latency; delete source → corpus empty → refusal; console
walkthrough) are nightly-live rows too — documented here so they are not
mistaken for gaps in the per-PR gate. The offline-implementable subset
(upsert → cited answer; re-upsert → answer changes; remove → refusal) runs
per-PR through the real tool once K1's `createKnowledgeTools` lands
(feature-detected, loud-skip until then).

## Reading a run

The runner writes `scorecard.json`/`scorecard.md` under
`corpus/.repos/.logs/` (per-engine copies under `corpus/.repos/knowledge-<engine>/run/`).
Each engine gets one scorecard section with layers: 1 retrieval (one check
per golden item: expected docs in top-5) · 2 refusals (one check per refusal
item; any hit = hard failure) · 3 judge (skipped offline, with the skip
stated) · 4 bars. With several `--engine` flags the metrics table gains one
column per engine — that table is the per-engine comparison report (spec
§Evals 6). Exit is nonzero under `--strict` when any hard failure exists.

## The verifier pass

The cloud calibration ([vendo-web
`docs/eval/knowledge-cloud/`](https://github.com/runvendo/vendo-web/tree/main/docs/eval/knowledge-cloud))
established that **no score threshold separates answerable from unanswerable
questions** on the Agentset engine: answerable questions span 0.674-0.866,
unanswerable ones 0.597-0.783, and the best bar (0.7211) still lets 16 of 34
unanswerable questions through while refusing 7 of 60 answerable ones. So a
cheap model reads the passages instead of trusting the number.

The first design spent that model call only inside the *band* — the region
where the two populations overlap and the score is provably useless. The live
measurement below is why it no longer does: the questions outside the band
were the ones nobody was checking.

### The live measurement

Run against the real engine, through the real tool, with real model calls.
`bands/agentset-verifier-live.json` carries a record per question per pass
(retrieved doc ids and scores, the verdict and its stated gap, the final
outcome, wall-clock latency) and **every number below recomputes from those
records** — `verifier-live.test.ts` re-derives each published aggregate in CI
and fails if the doc drifts off its data.

Two configurations were measured, and both are published, because the
difference between them is the finding:

- **ungated (what ships)** — the check reads every search that returns hits.
  `agentset-verifier-live.json`, `…-live-ungated-run1.json`, one pass each.
- **band-gated (K14's design, removed)** — the check ran only where the score
  landed inside the calibrated band [0.6735, 0.7835].
  `…-live-band-gated.json`, `…-run1.json`, `…-turn-budget-ab.json`, three
  passes each.

Everything else is identical: 59-doc fixture corpus in a throwaway Agentset
namespace, `weakScoreThreshold` 0 (main's default), per-call cap 5s, per-turn
budget 5s, verifier `claude-haiku-4-5` on the `knowledgeVerifier` slot, all 94
labelled questions.

| | ungated (ships) | band-gated (removed) |
|---|---|---|
| **False answers** per pass | 7/34 · 10/34 | 19/34 · 12/34 · 9/34 (run A) · 16/34 · 12/34 · 10/34 (run B) |
| **worst observed** | **10/34 — 29%** | **19/34 — 56%** |
| **False refusals** per pass | 3/60 · 3/60 | 2/60 (run A) · 3/60 (run B) |
| Searches the check read | 94/94 — 100% | 59-60/94 — 63% |
| Verifier calls per search | 1.37-1.39 | 0.93-0.98 |
| Verifier latency per verified turn (its calls, summed) | p50 2.5-2.6s · p95 5.0s | p50 3.2-3.7s · p95 5.0s |
| Verifier latency per call | p50 1.7-1.8s · p95 3.4-4.1s | p50 1.8-2.0s · p95 3.3-5.0s |
| Whole tool call | p50 3.5-3.7s · p95 6.7-6.8s | p50 2.3-2.6s · p95 6.0-6.6s |

**Does the spec's zero-false-answer bar hold? No.** The best configuration
still answered 7 and 10 of 34 unanswerable questions on its two passes. What
removing the gate bought is real and large — the worst pass went from 19/34 to
10/34, and the false-refusal side did not get worse — but "much better" is not
the bar, and this is why the check ships **off by default**.

**Where the remaining false answers come from.** Three exhaustive causes, one
per false answer, recomputed per pass by the run script and re-derived by the
test (`falseAnswersNeverVerified` + `falseAnswersNoVerdict` +
`falseAnswersVerifierSaidSupported` = `falseAnswers`):

| cause | ungated | band-gated (run A) |
|---|---|---|
| Never verified — outside the gate | **0** | 4 · 4 · 4 |
| No verdict — timed out, answered and flagged `unverified` | 4 · 8 | 12 · 6 · 3 |
| The verifier read the passages and said supported | 3 · 2 | 3 · 2 · 2 |

Removing the gate zeroed the first row, which is the whole reason it was
removed: those four questions per pass were never looked at, three of them
scoring *below* the band and one 0.0001 above its top edge (0.7836 against a
high of 0.7835 — the knife-edge that motivated the band, reappearing at the
band's own boundary). The dominant remaining cause is the timeout, which is
the fail-open path working as designed: those answers ship flagged. The last
row is the verifier being wrong — e.g. "Is there a pip package for Vendo?"
against npm passages returned *supported* ("the passages state that Vendo is
installed via the npm package @vendoai/vendo"), while its sibling paraphrase
"How do I install the Vendo Python SDK?" was correctly refused with the gap
"the passages describe installing the JavaScript SDK via npm, but do not
contain any information about installing a Python SDK".

**The schema/lookup branch, proven live.** The tables above are query-path
(chat→deep) measurements; `lookup: true` takes a different branch — one schema
search over the glossary/api kinds — and that branch previously carried **no
check at all**: any hit answered, no threshold ever applied. A targeted pass
(`bands/agentset-verifier-live-lookup.json`, recomputed by the same guard)
proves the branch with 12 existing labelled probes — six glossary-term golden
questions the corpus defines, six fact-lookup refusal questions it does not —
three passes, same namespace-and-sweep discipline. Result: **false answers 0/6
and false refusals 0/6 on every pass.** The row that earns the branch its
verifier: five of the six unanswerable lookups DID return schema hits
(adjacent glossary/API entries), which the unchecked branch would have
answered; the verifier refused all five with a named gap, and the sixth
returned no hits and answered an honest not-found. Verification here is one
call per lookup (this branch never escalates), p50 1.5-2.0s.

**Cost.** Measured, and counting the second call a chat→deep escalation makes:
**1.37-1.39 verifier calls per search** ungated (0.93-0.98 gated). At
`claude-haiku-4-5` list prices with a ~1.1k-token prompt and a ~60-token
verdict — ≈$0.0013 a call — that is **≈$0.0018 per search** ungated, ≈$0.0013
gated. The per-call price is a list-price estimate; the call count is
measured. Latency is measured throughout: the check adds p50 ~2.5s of
verification to a verified turn — the SUM of that turn's calls, which is more
than one call's median of ~1.7-1.8s because many turns verify twice — and the
per-turn budget bounds its share of one tool call at 5s however many times it
verifies (the p95 sitting at 5.0s is that wall doing its job).

### Sizing the per-turn budget, by measurement

A turn that escalates chat→deep verifies twice, so the per-call cap alone let
one tool call spend ~10s on verification. The per-turn budget bounds that. Its
size was chosen by running the whole corpus both ways rather than by taste
(`bands/agentset-verifier-live-band-gated-turn-budget-ab.json` is the 8s arm,
3 passes, same corpus and same day as band-gated run B):

| per-turn budget | false answers | false refusals | no verdict | tool call p95 |
|---|---|---|---|---|
| **5s (shipped)** | 16/34 · 12/34 · 10/34 | 3/60 | 37 | 6.5s |
| 8s | 16/34 · 12/34 · 11/34 | 2/60 | 25 | 8.1s |

The worst case is identical. Eight seconds buys about one answerable question
per pass and twelve fewer unverified flags, and costs 1.6s at p95 on a call
the user is waiting through. Five seconds ships; the trade is one constant
(`KNOWLEDGE_VERIFY_TURN_BUDGET_MS`) if that judgement ever changes. (That A/B
predates the gate's removal, so both its arms are band-gated; what it compares
is the budget, which the gate does not interact with.)

**Tuning discipline.** This is a model-costed leg, so the frozen-set posture
above applies: the verifier's standard was written from the calibration's
failure mode (adjacent-topic evidence) before any question was run and was not
edited afterwards. The two parameters taken from a run — the 5s per-call cap
and the 5s per-turn budget — come from measured latency and the A/B above, not
from which questions passed.

**What happened to the K14 table.** The previous lane published "false answers
47% → 3%" from a REPLAY: passages reconstructed with a different dense
retriever (top-document agreement with the real engine 42/94, and 4/34 on the
refusal set), the verifier called directly instead of through the tool, and
outcomes computed by hand. Those numbers were never observed on the real
engine and are withdrawn; the replay harness and its artifact are deleted so
they cannot be re-quoted. What survives from K14 is the calibration itself
(`bands/agentset.json`, `bands/agentset-deep-scores.json`) and the
implementation.

Re-run it (spends Agentset and model money; never part of `pnpm test` or CI):

```sh
AGENTSET_API_KEY=… ANTHROPIC_API_KEY=… \
  pnpm --filter @vendoai/corpus-harness knowledge-verifier-live
```

`LIVE_PASSES` sets the pass count; `LIVE_TURN_BUDGET_MS`,
`LIVE_WEAK_SCORE_THRESHOLD` and `LIVE_OUT` exist so a configuration question
gets answered by measurement instead of taste. The namespace is deleted and
proven gone at the end of every run, pass or fail.

## Run ledger

Official runs only (per-PR CI runs are not ledger entries; nightly and
calibration runs are).

| Date | Engine | recall@5 | MRR | judge.faithfulness | Notes |
|---|---|---|---|---|---|
| 2026-07-25 | memory | 1.000 | 1.000 | — (offline) | Calibration run at authoring time; bars seeded at measured values |
| 2026-07-26 | lexical | 0.100 | 0.055 | — (offline) | Calibration at K7 landing, natural questions. Retrieval baseline is weak (unnormalized term-frequency scoring; long common-token docs dominate; schema lookup honestly empty for question-shaped text) and the REFUSAL LAYER IS RED: off-corpus questions return junk hits, so the shipped zero-hits weakness policy answers them (6/60 golden items retrieved; 0/15 refusal items refused). Bars seeded at measured floors; lexical stays out of the per-PR gate until refusals go honest — this row is the suite catching a real quality gap, not noise |
| 2026-07-27 | agentset (replay) | — | — | — | WITHDRAWN. K14's verifier table ("false answers 47% → 3%") was a replay with reconstructed passages and a hand-computed outcome, not a live run; superseded by the row below. The harness and artifact are deleted |
| 2026-07-28 | agentset (live, band-gated) | — | — | — | K15 first measurement of K14's gated design, 94 questions × 3 passes × two runs: false answers 19/12/9 and 16/12/10 of 34 (worst 19/34 — 56%), false refusals 2-3/60, only 59-60/94 searches read. The gate was removed on the strength of this row |
| 2026-07-28 | agentset (live, ungated — ships) | — | — | — | The check on every hits-returning search: false answers 7/34 and 10/34 (worst 10/34 — 29%), false refusals 3/60, 94/94 searches read, 1.37-1.39 calls/search, verifier p50 1.7-1.8s per call (2.5-2.6s summed per verified turn), tool call p50 3.5-3.7s / p95 6.8s. **The zero-false-answer bar still does NOT hold**, which is why the check ships off by default |
