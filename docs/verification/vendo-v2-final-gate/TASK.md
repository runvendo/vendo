# TASK — FINAL 6-case gate on merged main (branch yousefh409/vendo-v2-final-gate)

RESUMABLE: commit each result the instant you capture it; resume from this README + git log if restarted.

## Phase 0 — shepherd the merge train (do this FIRST)
Three PRs with auto-merge armed must land on runvendo/vendo main, in this order (strict protection = each merge makes the next BEHIND):
1. #386 (speed) — CI running post-update-branch
2. #388 (interaction)
3. #387 (projection)

Loop: poll `gh pr view <N> --json state,mergeStateStatus`. When a predecessor merges and the next is BEHIND, nudge `gh api -X PUT repos/runvendo/vendo/pulls/<N>/update-branch`. Known gotchas: github-actions sometimes flakes on `synchronize` events — if checks never start after an update, push an empty commit or rebase to retrigger; do NOT merge a PR before its AI-reviewer triage is complete (all three are already triaged — Greptile/cubic/Devin comments answered on-thread). If a check FAILS (not flake), investigate honestly, fix on that branch minimally, keep auto-merge armed. All three PRs' code is done + browser-verified; your job is only landing them.

## Phase 1 — final full 6-case gate (only after ALL THREE are merged)
`git fetch origin main` and rebase this branch onto origin/main (it must include #385+#386+#387+#388). `pnpm install && pnpm build` in this worktree.

Run the SAME 6-prompt matrix as docs/verification/vendo-v2-propschema (on main), through the real Apps create path in a real browser:
- demo-bank (Maple): (1) "spending breakdown by category this month with a chart"; (2) "a filterable list of recent transactions"; (3) "a form to transfer money between two accounts".
- demo-accounting (Cadence): (4) "overdue invoices with a reminder button"; (5) "a revenue vs expenses summary with a chart"; (6) "a new-client intake form".

Boot: PRODUCTION only, NEVER `next dev` (40GB OOM). `next build && next start`, `NODE_OPTIONS=--max-old-space-size=3072`. Kill by port (`lsof -tiTCP:PORT -sTCP:LISTEN | xargs kill`). Maple: AUTH_SECRET + MAPLE_DEMO_PASSWORD, login yousef@maple.com. Cadence: `serverExternalPackages:["esbuild","@electric-sql/pglite"]`; mint HS256 Supabase JWT (SUPABASE_JWT_SECRET, aud+role authenticated, sub = seeded uuid from src/server/users.ts) into cookie `sb-cadence-auth-token`. Keys: /Users/yousefh/orca/workspaces/flowlet/.env → gitignored .env/.env.local, NEVER commit keys.

PASS bar (same as before): real app of host/prewired components + real data or HONEST empty-state/disclaimer + working chart where asked + populated Selects with real labels + money/dates formatted + actions carry payloads (or honest disclaimer when the host lacks the tool) + NO error-box/blob/raw-braces. Judge honestly; no tuning to force passes. ALSO record per-prompt timing (time to first paint + time to complete, visible in the surface or timed manually) — the speed lane instrumented the engine; capture what's observable.

Per prompt, IMMEDIATELY: screenshot → docs/verification/vendo-v2-final-gate/NN-<host>-<slug>.png (use `git add -f` — *.png is gitignored), append a row (host|prompt|PASS/FAIL|timing|note) to README.md here, commit.

## Done
Summary: N/6 with the full arc (2/6 baseline → 2/6 propschema → this run), per-class status (prop names ✓/✗, projection ✓/✗, formatting, island charts, action payloads, honesty), timing table, remaining known gaps (e.g. sequential paint→full lanes ≈ 9.9s complete; <1s paint needs owned serving). Open an evidence-only PR to main, self-triage AI reviewers, merge if green. Worktree comment "FINAL GATE: N/6 (<one-line>)". If blocked, commit what you have + say BLOCKED.
