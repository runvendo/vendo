# TASK — held-out gate, Cadence half (branch yousefh409/vendo-heldout-cadence)

RESUMABLE: commit each result the instant you capture it; resume from README-CADENCE.md if restarted.

Read CORPUS.md in this directory first. You run prompts **C1–C15** on **demo-accounting (Cadence) only**.

## HARD RULES
- **ZERO tuning, zero code changes.** This branch must contain ONLY evidence commits (screenshots, README rows, one GIF). If a prompt fails, that is the finding — record it and move on. Never modify packages/, prompts, or host code (exception: the known PGlite `serverExternalPackages:["esbuild","@electric-sql/pglite"]` packaging fix if the host won't boot, and .env files which stay gitignored).
- Judge against the PASS bar in CORPUS.md, honestly. [impossible] prompts pass only via honest handling (C9 payroll, C10 invoices have no host tools — a fabricated dashboard is a FAIL; C13: check the live tool registry first to know which branch applies).
- Record timing per prompt.

## Boot (production ONLY — never `next dev`, it OOMs at 40GB)
`pnpm install && pnpm build` first (fresh worktree). Then demo-accounting: `next build && next start`, `NODE_OPTIONS=--max-old-space-size=3072`, port 3200 (avoid the Maple worker on 3000). Ensure `serverExternalPackages:["esbuild","@electric-sql/pglite"]` in next.config (known Turbopack WASM bug). Auth: Supabase GoTrue — mint an HS256 JWT from `SUPABASE_JWT_SECRET` (aud+role "authenticated", sub = seeded uuid from src/server/users.ts) into cookie `sb-cadence-auth-token`. Kill by port. Keys: /Users/yousefh/orca/workspaces/flowlet/.env → gitignored, NEVER commit.
Boot ONCE, reuse for all 15 prompts.

## Per prompt (C1..C15, in order)
Drive the real Apps create path in a real browser. Wait for complete. Screenshot the FULL app (scroll + second shot if tall) → docs/verification/vendo-v2-heldout/C<NN>-<slug>.png (**git add -f** — pngs are gitignored). Append a row to README-CADENCE.md: `C<NN> | prompt | PASS/FAIL | timing | one-line note (name the failure class if FAIL)`. Commit IMMEDIATELY after each. Do not batch.

## One GIF
For C4 (message client) or C11 (quick message button) — whichever fires an action — record a short GIF of click → approval-gated confirmation via Chrome MCP gif_creator (cadence-action-fire.gif, commit with -f). If unavailable, before/after screenshots + note.

## Done
Summary in README-CADENCE.md: N/15, fails grouped by class, timing p50. Push the branch (`git push -u origin yousefh409/vendo-heldout-cadence`). NO PR — the orchestrator combines both halves. Worktree comment "HELDOUT-CADENCE: N/15". If blocked on boot, commit what you have + say BLOCKED.
