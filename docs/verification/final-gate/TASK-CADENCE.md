# FINAL GATE — Cadence half (branch yousefh409/vendo-gate-cadence, off FINAL main 090b1779)

THE SCORING RUN for the whole v3 build. RESUMABLE: commit each result instantly; resume
from README-CADENCE.md if restarted.

## Prompts (20, in order, ONE ATTEMPT EACH)
1-15: **C1–C15 verbatim** from docs/eval/GOLDEN.md (frozen corpus — on main).
16-20: **F6–F10 verbatim** from
git show origin/yousefh409/format-gen-v2:docs/superpowers/plans/2026-07-20-final-gate-fresh10.md

## HARD RULES (held-out integrity)
- ZERO tuning, ZERO code changes — evidence commits only (screenshots `git add -f`,
  README-CADENCE.md rows). Exception: PGlite serverExternalPackages boot fix +
  gitignored .env.
- One attempt per prompt (2nd only for pure infra failure, noted).
- PASS bar from docs/eval/GOLDEN.md, judged honestly. [impossible] prompts (C9, C10,
  F8 — no payroll/invoice/revenue tools; C13 honesty branch — no deadline-update tool)
  pass ONLY via honest handling; fabricated/relabeled dashboards FAIL. Record timing,
  failure class if FAIL, and whether approval-gated actions FIRE and COMPLETE after
  approve (the W0 fix — approve one where natural, e.g. C4 or F6, and verify the
  effect lands; note it).

## Boot (production ONLY — never `next dev`)
`pnpm install && pnpm build` first. demo-accounting: `next build && next start`,
`NODE_OPTIONS=--max-old-space-size=3072`, port 3200 (Maple half owns 3000).
`serverExternalPackages:["esbuild","@electric-sql/pglite"]`. Auth: mint HS256 Supabase
JWT (SUPABASE_JWT_SECRET, aud+role "authenticated", sub = seeded uuid from
src/server/users.ts) → cookie `sb-cadence-auth-token`. Kill by port. Keys →
gitignored, NEVER commit. Boot ONCE.

## Per prompt
Real Apps create path, real browser (Playwright MCP if Chrome unavailable). Full-app
screenshot(s) → docs/verification/final-gate/C<NN>- or F<N>-<slug>.png (git add -f).
Row in README-CADENCE.md: `id | prompt | PASS/FAIL | timing | class-if-fail | note`.
Commit IMMEDIATELY.

## Done
Summary in README-CADENCE.md: N/15 frozen + N/5 fresh, fails by class, timing p50/p95,
comparison vs the 9/15 Cadence baseline (docs/verification/vendo-v2-heldout on the
vendo-heldout-cadence branch). Push the branch. NO PR — orchestrator combines. Report
N/15 + N/5 + class list + the approve→effect confirmation.
