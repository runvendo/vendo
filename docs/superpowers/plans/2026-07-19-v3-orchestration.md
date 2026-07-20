# v3 build — orchestration state (resume from here if the session restarts)

AUTHORITY: docs/superpowers/specs/2026-07-19-vendo-v2-general-quality-design.md (the
2-pager, on branch yousefh409/format-gen-v2 AND pushed). Yousef's directive: build +
verify EVERYTHING, then score the frozen 30-prompt held-out corpus ONCE, honestly — no
tuning against it — and report (arc vs 11/30 baseline). He is away; full autonomy;
workers self-triage AI reviewers + self-merge green PRs (standing authorization).

## Lanes

| Lane | Worktree/branch (vendo-*) | Scope | Depends on | Status |
|---|---|---|---|---|
| W0 | w0-engine | approve→resume stall fix + e2e; freeze eval corpus | — | DISPATCHED |
| W1 | w1-bench | measurements: inline-refs vs Query, builder-calls fork, fetch-then-generate A/B, (best-effort) llguidance replay | — | DISPATCHED |
| W2 | w2-kit | the Kit (superset bar) + prop classes + generated prompt | — | DISPATCHED |
| W4a | w4-pipeline | structured repair + outline/region-parallel + end pass (engine-internal) | — | DISPATCHED |
| W3 | (create: w3-semantics) | semantic sync + law-1/law-2 compile checks + ADOPT inline refs (W1 Exp1) | W2 prop classes merged | pending |
| W4b | (create: w4-islands) | islands ambient scope + ambient tools + manifest inference | W2 merged (Kit-in-jail) | pending |
| W5 | (create: w5-regate) | dialect retirement + FINAL frozen-30 + 10 fresh gate + report | all merged | pending |

## Coordination rules (from the successful #385-#397 run)
- Each lane: TASK.md in docs/verification/<lane>/ is authority; commit early/often
  (resumable); pnpm build/test/typecheck/lint green; browser evidence for UI-affecting
  work (git add -f for pngs); PR to main; triage AI reviewers; auto-merge + update-branch
  under strict protection; never commit keys (.env from /Users/yousefh/orca/workspaces/flowlet/.env).
- engine.ts contention: W4a owns create-orchestration/repair internals; W1 touches
  compiler/bench behind flags only; W2 owns ui package + prompt-section content; rebase
  onto main before merge.
- Prod boots only for hosts (never `next dev` — 40GB OOM). Boot recipes in
  docs/verification/vendo-v2-heldout/TASK-*.md.
- W1 verdicts get written to docs/verification/w1-bench/VERDICTS.md — W3/W4b briefs read
  it to adopt winners (inline vs Query; builder-calls only if judged quality holds).

## Final deliverable (W5)
Frozen 30 (docs/verification/vendo-v2-heldout/CORPUS.md) + 10 FRESH prompts (W5 authors
them, never seen) — run ONCE on merged main, browser-judged, screenshots, per-class
table, arc: 11/30 → N/30. NO fixes during the run. Report to Yousef.

## W1 VERDICTS (2026-07-19, PR #414): Exp1 inline refs ADOPT (tie, binding-err 0.17 vs 0.56);
Exp2 builder-calls DEFER (composition survives, ref-error-free 65% vs 33%, but 44s vs 6.7s latency);
Exp3 fetch-then-generate DEFER (binding-err 0.00 but compile-ok 81% — prose refusals on negatives; revisit behind repair+Disclaimer-forcing);
Exp4 CFG DEFER (wire-subset.lark + 1-day GPU protocol delivered — owned-serving evidence line).
Cross-lane: both arms over-bind ~1 field/app at base — structured repair (W4a) is the designed fix.
