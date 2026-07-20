# W0 — approve→resume engine fix + eval freeze (branch yousefh409/vendo-w0-engine)

RESUMABLE: commit each step immediately; resume from git log if restarted.
Authority: docs/superpowers/specs/2026-07-19-vendo-v2-general-quality-design.md §Also.

## Part 1 — the bug (ships first, highest priority)
SYMPTOM (measured twice, held-out gate C4/C11): a mutating action fires → "Action is
waiting for approval (apr_…)" → human approves in the workspace surface → the action
stays "Running" FOREVER; the effect (e.g. host_sendClientMessage) never lands. Every
approval-gated mutation is silently broken.

Anchors from a first pass: approvals minted in packages/guard/src/guard.ts:849 (makeId
"apr_"); packages/apps/src/runtime.ts:1330 (apr_ ids / replay); UI-side string in
packages/ui/src/tree/mcp-shim/shim-core.ts:179 ("waiting for approval"). Trace the
approve path: who observes an approval flipping to granted, and who is responsible for
re-dispatching/resuming the pending call? Suspect: nobody re-dispatches (the pending
promise/step is dropped) or the resume path checks a stale grant.

TDD: FIRST write the failing e2e (fixtures/integration style): create app → dispatch
mutating action → approval requested → approve via the real approval API → assert the
TOOL EFFECT LANDED (host-side observable) and the action status resolves. It must fail
for the C4/C11 reason before you fix. Then fix minimally in the actions/runtime path.
Keep it clean; no redesign — this is a bug fix.

## Part 2 — freeze the eval
- Create docs/eval/GOLDEN.md on main: the 30 held-out prompts verbatim from
  docs/verification/vendo-v2-heldout/CORPUS.md (git show origin/yousefh409/vendo-heldout-maple:docs/verification/vendo-v2-heldout/CORPUS.md)
  + the PASS bar + the rules: FROZEN — never tuned against; run ONCE per wave;
  browser-judged with screenshots; any prompt discussed in a fix PR moves to the dev
  list (the 6 dev-set prompts, listed as dev). Note baseline: 11/30 on 2026-07-19.
- Nothing else — no harness build here.

## Done
pnpm build/test/typecheck/lint green. PR to main, self-triage AI reviewers, auto-merge
when green (update-branch if BEHIND). Worktree comment "W0: <one-line>". Report: root
cause, the fix, e2e proof.
