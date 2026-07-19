# TASK — held-out gate, Maple half (branch yousefh409/vendo-heldout-maple)

RESUMABLE: commit each result the instant you capture it; resume from README-MAPLE.md if restarted.

Read CORPUS.md in this directory first. You run prompts **M1–M15** on **demo-bank (Maple) only**.

## HARD RULES
- **ZERO tuning, zero code changes.** This branch must contain ONLY evidence commits (screenshots, README rows, one GIF). If a prompt fails, that is the finding — record it and move on. Never modify packages/, prompts, or host code (exception: the known PGlite `serverExternalPackages` packaging fix if the host won't boot, and .env files which stay gitignored).
- Judge against the PASS bar in CORPUS.md, honestly. [impossible] prompts pass only via honest handling.
- Record timing per prompt (submit → app visible; note if a "Creating…" indicator was shown).

## Boot (production ONLY — never `next dev`, it OOMs at 40GB)
`pnpm install && pnpm build` first (fresh worktree). Then demo-bank: `next build && next start` with `NODE_OPTIONS=--max-old-space-size=3072`, port 3000 (or a free port). Needs `AUTH_SECRET` + `MAPLE_DEMO_PASSWORD` in gitignored .env.local; login yousef@maple.com. Kill by port (`lsof -tiTCP:3000 -sTCP:LISTEN | xargs kill`); check for orphan processChild.js. Keys: /Users/yousefh/orca/workspaces/flowlet/.env → gitignored, NEVER commit.
Boot the host ONCE and reuse it for all 15 prompts.

## Per prompt (M1..M15, in order)
Drive the real Apps create path in a real browser (the /vendo apps surface or POST /api/vendo/apps then render). Wait for complete. Screenshot the FULL app (scroll + second shot if tall) → docs/verification/vendo-v2-heldout/M<NN>-<slug>.png (**git add -f** — pngs are gitignored). Append a row to README-MAPLE.md: `M<NN> | prompt | PASS/FAIL | timing | one-line note (name the failure class if FAIL)`. Commit IMMEDIATELY after each prompt. Do not batch.

## One GIF
For M8 (quick-transfer) or M11 (pay bill) — whichever fires an action — record a short GIF of the click → approval-gated confirmation using the Chrome MCP gif_creator (name it maple-action-fire.gif, commit with -f). If gif_creator is unavailable, take a before/after screenshot pair instead and note it.

## Done
Write a Summary section in README-MAPLE.md: N/15, fails grouped by class, timing p50. Push the branch (`git push -u origin yousefh409/vendo-heldout-maple`). NO PR — the orchestrator combines both halves. Set worktree comment "HELDOUT-MAPLE: N/15". If blocked on boot, commit what you have + say BLOCKED.
