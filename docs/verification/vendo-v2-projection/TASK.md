# LANE: data→shape PROJECTION + value FORMATTING (branch yousefh409/vendo-v2-correctness, off main)

RESUMABLE: commit each step + each screenshot the instant you have it. Sessions may restart; resume from git log + the README.

## Why (from the #385 browser gate, docs/verification/vendo-v2-propschema on main)
The prop-NAME fix landed (#385). Remaining top blocker: the model uses the correct `options` prop name but does NOT project fetched OBJECT arrays into the shapes prewired components need, and does not FORMAT values. Symptoms:
- #3 transfer form + #4 reminder form: account/client Selects bind a fetched array of objects (`{id,name,...}`) straight to `options`, so every option renders blank — Select needs `options: [{value,label}]`.
- #4 PROGRESS column renders raw JSON `{"received":3,"total":6}`; amounts show raw cents; dates show raw ISO.

## What exists already (REUSE, don't rebuild)
- Reshape vocabulary: `packages/core/src/reshape.ts` — ops `pick`, `rename`, `asPoints` (rows→`{label,value}`, args = labelField, valueField), `format` (kinds: number, currency, percent, date), + aggregates. Wire `|` pipe compiles to canonical `$reshape` steps (packages/core/src/wire-v2/expression.ts). Compile-time shape check: `packages/core/src/wire-v2/shape-check.ts` (runs when `toolShapes` present — it IS wired now: runtime.ts:761 → engine.ts:286). Prompt already emits "TOOL RESPONSE SHAPES" (engine.ts hostToolSections ~228).
- So money/date FORMATTING already works via `amount | format(currency)` / `date | format(date)` — the model just isn't using it. `format(currency)` on a CENTS value shows dollars-as-cents; check whether a cents scale is needed and handle it (add a `divide`/scale arg or a cents-aware path) so $471,711.00 becomes the correct amount.

## Scope (do in order; TDD each; keep it clean/minimal)
1. **Add an `asOptions(valueField, labelField)` reshape op** → maps an object array to `[{value, label}]` (mirror asPoints' strict per-row behavior). Unit-test it in reshape.test.ts. Keep the closed-vocabulary gates (findInvalidReshapeSteps, arity registry) updated.
2. **shape-check**: when a binding feeds `options` on a prewired Select (or Tabs `tabs`) and the source shape is an object array NOT already `[{value,label}]`, emit a per-binding error telling the model to project with `| asOptions(valueField, labelField)`. Route through the existing repair path. Same for a chart/points prop fed a raw object array → `| asPoints(...)`.
3. **Prompt guidance** (engine.ts — edit the "TOOL RESPONSE SHAPES"/reshape area ONLY, not the WIRE DIALECT actions/island section — another lane owns that): tell the model to project object arrays into the component's shape (`options={accounts | asOptions(id, name)}`) and to FORMAT money/dates (`{amount | format(currency)}`, `{date | format(date)}`), and never bind a raw object into a text/cell slot.
4. **Value formatting caveats**: ensure `format(currency)` handles integer cents correctly; nested-object cell (#4 PROGRESS) should be projected/picked to a scalar, not rendered raw.

Full gate must stay green: `pnpm install` then `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.

## Verify (the real gate)
Re-run these 4 prop-sensitive prompts through the real Apps create path in a real browser, PRODUCTION boot only (`next build && next start`, `NODE_OPTIONS=--max-old-space-size=3072`; kill by port `lsof -tiTCP:PORT -sTCP:LISTEN | xargs kill`; Maple needs AUTH_SECRET+MAPLE_DEMO_PASSWORD, login yousef@maple.com; Cadence needs `serverExternalPackages:["esbuild","@electric-sql/pglite"]` + a minted HS256 Supabase JWT cookie `sb-cadence-auth-token`). NEVER `next dev` (40GB OOM). Keys in /Users/yousefh/orca/workspaces/flowlet/.env → gitignored `.env`/`.env.local`, never commit keys.
- demo-bank: "a form to transfer money between two accounts" (account Selects must show real from/to account names); "spending breakdown by category this month with a chart" (amounts formatted as currency, not raw cents).
- demo-accounting: "overdue invoices with a reminder button" (client Select shows real client names; PROGRESS column not raw JSON).
PASS = Selects populated with real labels + values, money/dates formatted. Screenshot each → docs/verification/vendo-v2-projection/NN-*.png, append a row to README.md, commit immediately. No tuning to force a pass.

## Done
Summary in README (before/after on #3/#4 selects + formatting). Open a PR to main, self-triage AI reviewers (Greptile/cubic/Devin), merge if CI green. Comment on the worktree "PROJECTION: <one-line>". If blocked on host boot, commit what you have + say BLOCKED.
