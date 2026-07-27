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

## The verifier pass (K14)

The cloud calibration ([vendo-web
`docs/eval/knowledge-cloud/`](https://github.com/runvendo/vendo-web/tree/main/docs/eval/knowledge-cloud))
established that **no score threshold separates answerable from unanswerable
questions** on the Agentset engine: answerable questions span 0.674-0.866,
unanswerable ones 0.597-0.783, and the best bar (0.7211) still lets 16 of 34
unanswerable questions through while refusing 7 of 60 answerable ones. K14's
answer is the *band* — the overlap region, where the score is spent and a
cheap model reads the passages instead.

| | shipped bar alone | + verifier in the band |
|---|---|---|
| **False answers** (unanswerable question answered) | **16/34 — 47%** | **1-2/34 — 3-6%** |
| **False refusals** (answerable question refused) | **7/60 — 12%** | **4-6/60 — 7-10%** |
| Turns paying a model call | 0 | 61/94 — 65% |
| Added latency on those turns | — | p50 1.6s · p95 3.6s · cap 5s |

Ranges are the spread over repeated passes (a model verdict is not
deterministic; the committed artifact carries every pass). Verifications that
cross the 5s cap yield no verdict and fall open to the bar — 1-4% of calls.
Fifteen of the sixteen false answers are fixed and none is introduced; the
false-refusal side improves too, because inside the band the verifier also
rescues answerable questions the bar was refusing.

**Tuning discipline.** This is a model-costed leg, so the frozen-set posture
above applies: the verifier's standard was written from the calibration's
failure mode (adjacent-topic evidence) before any question was run, and it was
not edited afterwards. The one parameter set from the run is the 5s cap, taken
from the measured latency distribution, not from which questions passed.
Per-question verdicts stay out of the repo for the same reason.

Where the numbers live: `bands/agentset.json` (the band and its derivation),
`bands/agentset-deep-scores.json` (the live run's per-question scores, imported
with provenance), `bands/agentset-verifier-replay.json` (this table).

**Read this before quoting the table.** This is a REPLAY, not a live run. The
questions and the corpus are byte-identical to the live Agentset run's, and
every question's band placement is that run's measured deep-intent top score.
The *passages* are reconstructed — the committed measurements record scores and
the top document, not the returned text, and this repo cannot reach Agentset.
The reconstruction is a dense retrieval over the same corpus with the house
chunker, and it is not an easier corpus: it gets top-1 right 44/60 against the
live run's 46/60, with recall@5 57/60. The two retrievers pick different top
documents on about half the questions, so the artifact also reports the same
before/after on the subset where they agree.

Re-run it (spends model money; never part of `pnpm test` or CI):

```sh
OPENAI_API_KEY=… ANTHROPIC_API_KEY=… \
  pnpm --filter @vendoai/corpus-harness knowledge-verifier-replay
```

The retrieval half caches to `evidence/`, so repeat runs only re-verify.
`REPLAY_PASSES` and `VERIFY_TIMEOUT_MS` override the pass count and the cap.
Unpark this into a live run by extending vendo-web's calibration script to dump
the passages it retrieved.

## Run ledger

Official runs only (per-PR CI runs are not ledger entries; nightly and
calibration runs are).

| Date | Engine | recall@5 | MRR | judge.faithfulness | Notes |
|---|---|---|---|---|---|
| 2026-07-25 | memory | 1.000 | 1.000 | — (offline) | Calibration run at authoring time; bars seeded at measured values |
| 2026-07-26 | lexical | 0.100 | 0.055 | — (offline) | Calibration at K7 landing, natural questions. Retrieval baseline is weak (unnormalized term-frequency scoring; long common-token docs dominate; schema lookup honestly empty for question-shaped text) and the REFUSAL LAYER IS RED: off-corpus questions return junk hits, so the shipped zero-hits weakness policy answers them (6/60 golden items retrieved; 0/15 refusal items refused). Bars seeded at measured floors; lexical stays out of the per-PR gate until refusals go honest — this row is the suite catching a real quality gap, not noise |
| 2026-07-27 | agentset (replay) | — | — | — | K14 verifier pass: false answers 47% → 3%, false refusals 12% → 7-10%, band 65% of turns, p50 1.6s/p95 3.6s. Band placement from the live cloud run's scores; passages reconstructed (see §The verifier pass) |
