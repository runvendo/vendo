# W1 — format measurements (branch yousefh409/vendo-w1-bench)

RESUMABLE: commit each experiment result immediately. Authority: spec §Reliability
mechanisms "Measure". PURPOSE: produce VERDICTS.md that downstream lanes read. These are
bench experiments — prototype code stays behind flags / in bench harnesses; only merge
what's needed to reproduce the measurements. Keys: /Users/yousefh/orca/workspaces/flowlet/.env → gitignored.

Use live model calls against the demo-host catalogs/tools (engine.live.test / corpus
harness patterns exist). ~15-20 diverse prompts per arm (NOT the frozen 30 — author your
own dev prompts), judge with a rubric (compile-error rate, reference-error rate, judged
quality 1-5 via LLM judge, tokens, latency p50). Commit per-arm raw results + a table.

## Experiment 1 — inline tool refs vs <Query> declarations
Prototype inline references in the wire compiler behind an option (`inlineRefs: true`):
`rows={invoices.list({status:"overdue"}).data}` parses to the same canonical
query+binding (compiler mints the query, dedupes by tool+args). A/B same prompts, both
arms, same model. VERDICT = which arm has fewer reference/compile errors + better
declared-but-unused / wrong-query rates; ties → inline (simpler).

## Experiment 2 — builder-calls fork
Arm A: current single-stream JSX. Arm B: app emitted as strict tool calls (Anthropic
strict tool use, GA): one tool per prewired component (schemas already exist in
core/catalog + tree-limits; generate tool defs from them), begin_region/end_region for
nesting (order-based; compiler still mints ids), bind_data(tool enum, field-path enum
from sampled shapes), define_island(name, source string). All in ONE assistant turn.
Reliability is expected ~guaranteed; the GO/NO-GO METRIC IS JUDGED QUALITY (does
composition survive 25 discrete calls?) + tokens/latency. Remember think-then-constrain:
let the model think free-form (extended thinking or a scratchpad turn) before the
constrained emission — measure with it on.

## Experiment 3 — fetch-then-generate vs shape-cards-only
Arm A: today (shape cards in prompt). Arm B: phase-1 no-think strict call selects read
tools+args → runtime executes (read policy, ~1.5s timeout, fall back to cards) → phase-2
generation sees per-tool: args, shape, rowCount, 2-3 truncated sample rows. Measure:
field-reference errors, wrong-format (cents!) errors, silent-empty incidents, honesty on
2-3 negative prompts, complete-time delta. VERDICT = adopt only if beats cards outside
noise.

## Experiment 4 (best-effort) — llguidance CFG-JSX replay
Only if practical without buying infra: a Lark grammar for a subset of the wire
(component names from one host's catalog, prop-name sets, tool-ref grammar) + replay ~10
prompts on an open-weights model via vLLM/SGLang on any available GPU (Modal/e2b/cloud
w/ existing creds). If no infra: SKIP, write the grammar file + the experiment protocol
into VERDICTS.md as ready-to-run. Do not burn more than ~2h on infra fights.

## Done
docs/verification/w1-bench/VERDICTS.md: per-experiment tables + one-line verdicts
(ADOPT/REJECT/DEFER each). PR to main (bench + flagged prototypes only), self-triage,
auto-merge. Worktree comment "W1: <verdict one-liner>".
