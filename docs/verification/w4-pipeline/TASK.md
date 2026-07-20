# W4a — reliability pipeline (branch yousefh409/vendo-w4-pipeline)

RESUMABLE: commit per step. Authority: spec §How a generation runs. All engine-internal
(behind the GenerationEngine seam in packages/apps/src/engine.ts) — wire format,
compiler, renderer untouched. You OWN engine.ts create-orchestration/repair internals
(coordinate: W1 touches compiler behind flags; W2 is ui-package).

## 1 — Structured repair (adopt-now; biggest cheap win)
Replace the free-form repair loop (engine.ts repairPrompt ~line 734 + its callers): the
compiler already localizes failures with closed fix spaces. Build one strict tool-use
call (Anthropic strict, GA — flat schema, no recursion) whose schema enumerates each
pending failure's legal fixes: bad binding → enum of the tool's REAL field paths (from
shape cards); bad tool/action → enum of registry tools; mutation-without-payload →
payload skeleton from the tool input schema; EVERY field also gets a
"__no_valid_fix__" arm → that node becomes Disclaimer/dropped. Splice results
deterministically into the canonical tree; re-validate; at most 2 rounds then fall back
to today's loop. TDD with scripted-model fixtures (pattern exists in engine.test.ts).
Measure on ~10 live dev prompts: repair rounds, repair wall-clock, post-repair
error-free rate, __no_valid_fix__ take-rate (vs current loop) → commit numbers.

## 2 — Outline + region-parallel tier-2
Evolution of the existing tier0-wired design (tier-2 already hot-swaps subtrees over
tier-0's layout by stable id). Add: a small strict outline call (sections + tools per
section + SHARED facts: shared data refs/state; coupled sections marked one-unit) →
tier-2 becomes N parallel per-section calls, each seeing only its section's tool
shapes + the shared host prefix (prompt-cache-friendly), compiling/repairing
independently, hot-swapping in as they land. Coupled/one-unit asks and outline failures
fall back to today's single-stream (never block). Config flag to disable. Measure on
~10 live prompts: per-class error rate, complete p50/p95, coherence spot-check,
fallback rate → commit numbers.

## 3 — End pass
After assembly: one no-think read-through call (app JSX + the ask) emitting 0-2 patches
in the EXISTING edit-patch dialect (compileWirePatchV2) — each compile-validated, polish
only (dedupe titles/stats, retitle, drop redundancy); invalid patches dropped silently;
skippable flag; +~1s budget. TDD with scripted fixtures.

## Done
Gates green; live before/after numbers committed in README.md here; browser sanity
(one real generation on a prod-booted host, screenshot, git add -f; boot recipe in
docs/verification/vendo-v2-heldout/TASK-MAPLE.md — never `next dev`). PR, self-triage,
auto-merge. Worktree comment "W4a: repair Xs→Ys, complete p95 As→Bs".
