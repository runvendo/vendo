# FINAL GATE — Maple half (branch yousefh409/vendo-gate-maple, off FINAL main 090b1779)

THE SCORING RUN for the whole v3 build. RESUMABLE: commit each result the instant you
capture it; resume from README-MAPLE.md if restarted.

## Prompts (20, in order, ONE ATTEMPT EACH)
1-15: **M1–M15 verbatim** from docs/eval/GOLDEN.md (the frozen corpus — on main).
16-20: **F1–F5 verbatim** from
git show origin/yousefh409/format-gen-v2:docs/superpowers/plans/2026-07-20-final-gate-fresh10.md

## HARD RULES (held-out integrity)
- ZERO tuning, ZERO code changes — evidence commits only (screenshots via `git add -f`,
  README-MAPLE.md rows). Exception: the PGlite serverExternalPackages packaging fix if
  the host won't boot, and gitignored .env files.
- One attempt per prompt (second attempt only for pure infrastructure failure — host
  down/browser crash — noted in the row).
- Judge against the PASS bar in docs/eval/GOLDEN.md, honestly. [impossible] prompts
  (M12, M13, F4) pass ONLY via honest handling — Disclaimer or honest reframe; a
  fabricated app is a FAIL. Also record per prompt: timing (submit → app visible; note
  paint if separable), which failure CLASS if FAIL, and one flag: did structured
  repair visibly engage (slow first paint / retries)?

## Boot (production ONLY — never `next dev`, 40GB OOM)
`pnpm install && pnpm build` first. demo-bank: `next build && next start`,
`NODE_OPTIONS=--max-old-space-size=3072`, port 3000. AUTH_SECRET + MAPLE_DEMO_PASSWORD
in gitignored .env.local; login yousef@maple.com. Kill by port; check for orphan
processChild.js. Keys: /Users/yousefh/orca/workspaces/flowlet/.env → gitignored,
NEVER commit. Boot ONCE, reuse for all 20.

## Per prompt
Real Apps create path in a real browser (Playwright MCP if Chrome MCP unavailable).
Full-app screenshot (scroll + 2nd shot if tall) → docs/verification/final-gate/M<NN>-
or F<N>-<slug>.png (git add -f). Row in README-MAPLE.md:
`id | prompt | PASS/FAIL | timing | class-if-fail | note`. Commit IMMEDIATELY.

## Done
Summary in README-MAPLE.md: N/15 frozen + N/5 fresh, fails by class, timing p50/p95,
comparison vs the 2/15 Maple baseline (docs/verification/vendo-v2-heldout on the
vendo-heldout-maple branch — per-prompt before/after where interesting). Push the
branch. NO PR — the orchestrator combines halves. Report N/15 + N/5 + class list.
