# LANE: island jail-import gate + action PAYLOAD binding + honest GROUNDING (branch yousefh409/vendo-v2-interaction, off main)

RESUMABLE: commit each step + screenshot the instant you have it; resume from git log + README.

## Why (from the #385 browser gate, docs/verification/vendo-v2-propschema on main)
Two deferred failure classes + three AI-reviewer fast-follows remain:
- #5 revenue-vs-expenses: model emits a generated <Island>; prior it imported `recharts` (jail rejected → error box); the create-time island gate checks syntax + default export but NOT imports. Also it fabricated data ($60 revenue) instead of an honest empty-state when the host has no matching tools.
- #6 intake form + #4 reminder: action buttons carry no `onClick`/payload; a mutating action with no per-row/form payload, or wired to a READ tool, is a fake affordance. When the host has NO mutating tool for the ask, the app must honestly disclaim, not fake a Submit.
- AI-reviewer fast-follows from #385 (fold in): (a) `catalogIssues` on the EDIT path (engine.ts ~690) isn't filtered like create; (b) undefined-`source` nodes bypass the prewired prop-name check; (c) Stack/Row `gap` accepts a string in schema but should be number.

## Anchors
- Island gate: `islandIssues` in packages/apps/src/engine.ts (~363) — currently `hasDefaultExport` + esbuild TSX syntax only. Jail allowlist = `JAIL_MODULES` in packages/ui/src/tree/jail/runtime-entry.tsx: exactly `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, `react/jsx-dev-runtime`.
- Actions are canonical `{action, payload?}` on props (e.g. `onClick:{action:"host_tool", payload:{...}}`). Tool risk (read vs write) is on `deps.tools[].risk`. Validation lives in `catalogIssues` (engine.ts ~615) → repair loop.

## Scope (in order; TDD; clean/minimal)
1. **Island import allowlist gate**: add a shared `JAIL_ALLOWED_MODULES` constant (best in packages/core, single source) and derive `JAIL_MODULES` keys from it in runtime-entry.tsx (or a drift test asserting they match). In `islandIssues`, extract every import specifier from island source and reject any not in the allowlist → issue → repair. Prompt (WIRE DIALECT island rule, engine.ts ~216): state islands may ONLY import react/react-dom; for charts, emit a dependency-free inline-SVG island or use prewired/host components — never an external chart lib.
2. **Action payload + read/write guard**: in `catalogIssues`, when an `on*` action targets a host tool whose risk is mutating/write, require a non-empty `payload` binding (per-row id / form field refs); flag an action wired to a READ tool on a submit/primary button; flag a submit/primary Button with NO action when the request implies a mutation. Route to repair. Add prompt guidance: bind form/row context into the action payload; if no host tool can perform the action, render an honest disclaimer (Text/Badge) instead of a dead button — never fake a submit.
3. **#5 honest empty-state**: prompt guidance already partly exists ("leave the region out rather than inventing data") — extend to charts/metrics: when no host tool provides the numbers, render an honest empty-state, never fabricated figures.
4. **Fast-follows**: filter `catalogIssues` on the edit path the same way create does; make the prewired prop-name check also cover `source===undefined` nodes that resolve to a prewired name; tighten Stack/Row `gap` schema to number.

Gate stays green: `pnpm install` then `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.

## Verify (real browser, PRODUCTION boot only — see boot recipe below)
NEVER `next dev` (40GB OOM). `next build && next start`, `NODE_OPTIONS=--max-old-space-size=3072`, kill by port. Maple: AUTH_SECRET+MAPLE_DEMO_PASSWORD, login yousef@maple.com. Cadence: `serverExternalPackages:["esbuild","@electric-sql/pglite"]` + minted HS256 Supabase JWT cookie `sb-cadence-auth-token`. Keys in /Users/yousefh/orca/workspaces/flowlet/.env → gitignored, never commit.
- demo-accounting: "a revenue vs expenses summary with a chart" (chart renders OR honest empty-state, NO error box, NO fabricated figures); "a new-client intake form" (Submit either wired with payload OR an honest disclaimer, no dead button); "overdue invoices with a reminder button" (reminder action carries payload).
PASS = no jail error box, no fake affordance, honest empty-state where the host lacks tools. Screenshot each → docs/verification/vendo-v2-interaction/NN-*.png, append README row, commit immediately. No tuning to force a pass.

## Done
Summary in README. PR to main, self-triage AI reviewers, merge if CI green. Worktree comment "INTERACTION: <one-line>". Coordinate engine.ts: you edit the WIRE-DIALECT island/action prompt section + islandIssues + catalogIssues; another lane edits the TOOL-RESPONSE-SHAPES section — regions differ, rebase onto main before merge. If blocked on boot, commit + say BLOCKED.
