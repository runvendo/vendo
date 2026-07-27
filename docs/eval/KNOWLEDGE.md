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
unanswerable questions through while refusing 7 of 60 answerable ones. The
answer is the *band* — the overlap region, where the score is spent and a
cheap model reads the passages instead.

### The live measurement (K15)

Run against the real engine, through the real tool, with real model calls:
`bands/agentset-verifier-live.json` carries a record per question per pass
(retrieved doc ids and scores, the verdict and its stated gap, the final
outcome, wall-clock latency), and **every number below recomputes from those
records** — `verifier-live.test.ts` re-derives the table in CI and fails if the
two ever disagree.

Configuration measured: 59-doc fixture corpus in a throwaway Agentset
namespace · band [0.6735, 0.7835] · `weakScoreThreshold` 0 (main's default,
which is what a Cloud host runs) · per-call cap 5s · per-turn budget 5s ·
verifier model `claude-haiku-4-5` on the `knowledgeVerifier` slot · 94
questions × 3 passes. The shipped configuration was measured **twice**, on
separate namespaces (`agentset-verifier-live.json` and
`…-live-run1.json`); both runs are committed and both are reported, because
reporting the kinder of two runs is how a table stops being evidence.

| | pass 1 | pass 2 | pass 3 | worst |
|---|---|---|---|---|
| **False answers**, run A | 19/34 — 56% | 12/34 — 35% | 9/34 — 26% | **19/34 — 56%** |
| **False answers**, run B | 16/34 — 47% | 12/34 — 35% | 10/34 — 29% | 16/34 — 47% |
| **False refusals**, run A | 2/60 — 3% | 2/60 | 2/60 | **2/60 — 3%** |
| **False refusals**, run B | 3/60 — 5% | 3/60 | 3/60 | 3/60 — 5% |
| Turns the band routed to the verifier | 59/94 — 63% | 59/94 | 59/94 | — |
| Verifications (a turn can verify twice) | 87 | 90 | 92 | — |
| No verdict → answered, flagged unverified | 14 | 9 | 4 | 14 |
| Verifier latency on a verified turn | p50 2.01s · p95 5.00s | p50 1.88s · p95 4.05s | p50 1.83s · p95 3.33s | — |
| Whole tool call | p50 2.57s · p95 6.60s | p50 2.42s · p95 6.21s | p50 2.58s · p95 6.04s | max 8.2s |

(Rows without a run label are run A; run B's are within one or two of them and
are in its artifact.)

**Does the spec's zero-false-answer bar hold? No.** Over six passes the
refusal set lost between 9 and 19 of its 34 questions to confident answers —
the worst pass is exactly the 47-56% the score bar alone gets wrong. Pass-to-
pass spread is large because a model verdict is not deterministic, which is
itself worth knowing: a single pass of this eval cannot certify anything.

The verifier's *judgement* is sound — over run A it returned 160 unsupported
against 82 supported verdicts and produced refusals a threshold alone would
never have made. What fails is everything around it. The false answers
decompose into three causes:

1. **Outside the band, so never verified — 4 every pass.** The band routes;
   what it does not route is decided by the host's `weakScoreThreshold`, and
   main's default is 0, which answers anything with hits. Three of these score
   *below* the band (0.597, 0.628, 0.670) and one lands 0.0001 above its top
   edge (0.7836 against a high of 0.7835 — the same knife-edge that motivated
   the band, now at the band's own boundary, because a band fitted to the
   extremes of one run does not transfer exactly to the next).
2. **No verdict — 14, 9, 4 in run A.** The verification did not come back in
   time, so the tool answered as it would have without a verifier and flagged
   the result `unverified`. This is the fail-open path working as designed,
   and it is the largest single cause and the most volatile one.
3. **A genuine miss — the remainder, one to three per pass.** The verifier
   read the passages and called them sufficient. Example: "Is there a pip
   package for Vendo?" against passages about the npm package returned
   *supported* ("the passages state that Vendo is installed via the npm
   package @vendoai/vendo"), while its sibling paraphrase "How do I install
   the Vendo Python SDK?" was correctly refused with the gap "the passages
   describe installing the JavaScript SDK via npm, but do not contain any
   information about installing a Python SDK".

The practical reading: **the verifier is a second opinion, not a refusal
policy.** It can only improve questions the band routes to it, it cannot
refuse when it has no verdict, and on an engine whose threshold is 0 the
questions it never sees are answered by default. Zero false answers needs the
verifier *and* a calibrated threshold under it; that threshold is the host's
to set (enabling the verifier deliberately moves nobody's threshold — K15 T2),
and the Cloud engine's shipped default is 0. Whether the Cloud engine should
default to its measured bar (0.7211) as an engine default, independent of the
verifier, is a live-behaviour decision and is filed, not taken.

**Cost.** One cheap-model call on 63% of searches (0.95 calls per search over
run A). At `claude-haiku-4-5` list prices with a ~1.1k-token prompt and a
~60-token verdict that is ≈ $0.0013 per verified search, ≈ $0.0008 per search
overall — an estimate from the measured call count and list prices, not a
billing readout. Added latency is measured, not estimated: p50 1.8-2.0s on a
verified turn, and the per-turn budget bounds the verifier's share of one tool
call at 5s however many times it verifies.

### Sizing the per-turn budget, by measurement

A turn that escalates chat→deep verifies twice, so the per-call cap alone let
one tool call spend ~10s on verification. The per-turn budget bounds that. Its
size was chosen by running the whole corpus both ways rather than by taste
(`bands/agentset-verifier-turn-budget-ab.json` is the 8s arm, 3 passes, same
corpus, same day as run B):

| per-turn budget | false answers | false refusals | no verdict | tool call p95 |
|---|---|---|---|---|
| **5s (shipped)** | 16 · 12 · 10 | 3 · 3 · 3 | 37 | 6.5s |
| 8s | 16 · 12 · 11 | 2 · 2 · 2 | 25 | 8.1s |

The worst case is identical. Eight seconds buys about one answerable question
per pass and twelve fewer unverified flags, and costs 1.6s at p95 on a call
the user is waiting through. Five seconds ships; the trade is one constant
(`KNOWLEDGE_VERIFY_TURN_BUDGET_MS`) if that judgement ever changes.

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
| 2026-07-28 | agentset (live) | — | — | — | K15 verifier pass, live engine + real tool + real model, 94 questions × 3 passes × two runs: false answers 19/12/9 and 16/12/10 of 34 (worst 19/34 — 56%), false refusals 2-3/60, band routed 59-60/94 turns, verifier p50 1.8-2.0s, tool call p50 2.5s / p95 6.6s. **The zero-false-answer bar does NOT hold** — see §The verifier pass for the three causes |
