# v3 build — orchestration state (resume from here if the session restarts)

AUTHORITY: docs/superpowers/specs/2026-07-19-vendo-v2-general-quality-design.md (the
2-pager, on branch yousefh409/format-gen-v2 AND pushed). Yousef's directive: build +
verify EVERYTHING, then score the frozen 30-prompt held-out corpus ONCE, honestly — no
tuning against it — and report (arc vs 11/30 baseline). He is away; full autonomy;
workers self-triage AI reviewers + self-merge green PRs (standing authorization).

## Lanes

| Lane | Worktree/branch (vendo-*) | Scope | Depends on | Status |
|---|---|---|---|---|
| W0 | w0-engine | approve→resume stall fix + e2e; freeze eval corpus | — | MERGED #412 |
| W1 | w1-bench | measurements → VERDICTS.md | — | MERGED #414 |
| W2 | w2-kit | the Kit: 31 components, superset | — | MERGED #415 |
| W4a | w4-pipeline | structured repair ON (14.6s→1.4-3.1s) + region-parallel FLAGGED OFF + end pass opt-in | — | MERGED #417 |
| W3 | w3-semantics | semantics.json both hosts + domain manifests + law1/law2 checks + inline refs ADOPTED | — | MERGED #425+#432 |
| W4b | w4-islands | islands ambient scope + ambient tools + manifest | W2 ✅ | DISPATCHED |
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

## W3 MERGED 2026-07-20 (#425 + #432): .vendo/semantics.json both hosts (money.cents/date.iso/enums/ids
+ has/hasNot domain manifests); law-1 literal-data compile rejection (routes to structured repair);
law-2 payload = tool's exact required params + literal query inputs; inline refs ON in production
(inlineTools extension for single-segment names; <Query> still accepted); kitPrompt hoisted to core;
live 5/6 PASS + 1 PARTIAL-honest. CAVEAT for W4b: island names can't shadow Kit names anymore (forwarded).
Remaining: W4b (running) → W5 (retirement + frozen-30 final gate + report).

## FINAL GATE DISPATCHED 2026-07-20 (main @ 090b1779 = FULL v3: #412 #414 #415 #417 #425 #432 #433 #434 #435).
Two halves: vendo-gate-maple (M1-15 + F1-5, port 3000), vendo-gate-cadence (C1-15 + F6-10, port 3200).
One attempt each, zero fixes, GOLDEN.md bar, screenshots committed per prompt, branches pushed, NO PRs.
Orchestrator combines -> final report (arc 11/30 -> N/30 + fresh 10) + results page + evidence PR.
