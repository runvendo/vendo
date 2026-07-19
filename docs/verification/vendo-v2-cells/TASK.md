# LANE: object-valued cells + format-op enforcement — the LAST failure class (branch yousefh409/vendo-v2-cells, off main)

RESUMABLE: commit each step + screenshot immediately; resume from README + git log if restarted.

## Why (from docs/verification/vendo-v2-final-gate on the yousefh409/vendo-v2-final-gate branch / PR #395)
Final gate on merged main = 4/6. BOTH fails (#4 overdue-invoices, #5 revenue-vs-expenses, both Cadence) are ONE class:
- **Object-valued table cells render raw JSON braces**: PROGRESS `{"received":3,"total":6}`, ASSIGNED TO `{"id":"st_maya","name":"Maya Alvarez",...}` — the reshape vocab has no object→string projection for a cell, and nothing flags an object-shaped binding landing in a display slot.
- **The model applies NO format ops on Cadence tables**: raw ISO dates (`2026-07-21T17:00:00-07:00`) everywhere, though `format(date)`/`format(currencyCents)` work and ARE used on Maple (#1/#2 formatted correctly). Inconsistent adherence, unenforced.

Everything else is fixed and held (prop names, asOptions projection, action payloads firing, honesty disclaimers, island charts). This class is the whole gap to 6/6.

## Scope (TDD; clean/minimal; the vocabulary stays bounded/pure/non-Turing)
1. **Cell-level scalar projection.** Give the model a bounded way to render an object field as a readable cell. Prefer the SIMPLEST addition that closes both symptoms — e.g. a `template("...")`-style or `join(...)` reshape op producing a string from named fields (`template("{received} of {total}")`), OR nested-field column keys (`assignedTo.name`) if Table column keys can address nested scalars more cheaply. Pick ONE mechanism, justify in the PR, keep the closed-vocabulary gates (arity registry, findInvalidReshapeSteps) updated. Update reshape.test.ts.
2. **Compile-time enforcement (the reliable half).** In shape-check (packages/core/src/wire-v2/shape-check.ts): when a binding's resolved shape puts an OBJECT (non-scalar, non-{value,label}, non-points) into a Table column/display slot, emit a per-binding error routing the model to project it to a scalar (pick/nested key/template) — same repair pattern as the asOptions check (#387). Also flag a `date`-ish field (ISO string per the shape card / field name heuristic ONLY if shape cards carry format info — do NOT overreach on heuristics; if unreliable, rely on prompt + the object-cell check alone and say so honestly).
3. **Prompt nudge** (engine.ts TOOL RESPONSE SHAPES area — the #387 lane's region): tables/stat display slots must be scalars; project objects with the new op/nested keys; always `format` date and cents fields in display columns.
4. Consider WHY Cadence generations skipped format ops while Maple used them (both prompts share the same contract — check if the Cadence path somehow lacks the toolShapes/shape-card context; if so THAT is the real fix). Investigate before adding mechanism.

Gate stays green: `pnpm install` then `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.

## Verify (real browser, production boot ONLY — never `next dev`, 40GB OOM)
Cadence (demo-accounting) boot: `next build && next start`, `NODE_OPTIONS=--max-old-space-size=3072`, `serverExternalPackages:["esbuild","@electric-sql/pglite"]`, mint HS256 Supabase JWT (SUPABASE_JWT_SECRET, aud+role authenticated, sub = seeded uuid from src/server/users.ts) → cookie `sb-cadence-auth-token`. Kill by port. Keys: /Users/yousefh/orca/workspaces/flowlet/.env → gitignored .env, NEVER commit.
Re-run the two failing prompts:
- (4) "overdue invoices with a reminder button" — PASS = no raw braces in any cell, dates formatted, reminder still fires with payload.
- (5) "a revenue vs expenses summary with a chart" — PASS = no raw braces, dates formatted, chart still renders, honest data/disclaimer intact.
Also ONE Maple regression check: (2) "a filterable list of recent transactions" still PASSES (formatting + projection intact).
Screenshots → docs/verification/vendo-v2-cells/NN-*.png (**git add -f** — pngs gitignored), README row + commit after EACH. No tuning to force passes.

## Done
Summary in README (per-prompt before/after; state honestly if 6/6-equivalent is reached on the re-run set). PR to main, self-triage AI reviewers (Greptile/cubic/Devin), merge if CI green (auto-merge + update-branch if BEHIND under strict protection). Worktree comment "CELLS: <one-line>". If blocked, commit + say BLOCKED.
