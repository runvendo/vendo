# v2 interaction lane — browser gate (island jail-import gate + action payload + honest grounding)

Branch `yousefh409/vendo-v2-interaction`, off `origin/main` (carries PR #385).
Verifies the three deferred/adjacent failure classes this lane targets, on the
demo-accounting host (Cadence). All three verification prompts from the task
are Cadence prompts.

## What this lane added

1. **Island import-allowlist gate.** Shared `JAIL_ALLOWED_MODULES` in
   `@vendoai/core` is the single source: the jail runtime's require table is
   typed `Record<JailModule, unknown>` (drift is a compile error) and
   `islandIssues` (engine.ts) rejects any island importing a specifier outside
   `react`/`react-dom` → repair. Prompt steers charts to dependency-free inline
   SVG or prewired/host components. Closes verify-v2 #5's `recharts` error box.
2. **Action-wiring honesty guard.** `actionIssues` (engine.ts) routes to repair
   when an action invokes a mutating (write/destructive) host tool with **no
   payload**, when a submit/primary button is wired to a **read-only** tool, or
   when a submit-labelled button carries **no action at all**. Prompt tells the
   model to bind the row/form context into the payload, or — when the host has
   no tool for the ask — render an honest disclaimer instead of a fake submit.
3. **Honest empty-state prompt** for charts/metrics with no backing tool (never
   fabricated figures).
4. **PR #385 fast-follows:** edit path filters `catalogIssues` + `actionIssues`
   against the source app (an edit to an untouched node never blocks on a legacy
   node's stale prop/action); the prewired prop-name gate now covers
   `source===undefined` nodes; Stack/Row `gap` schema tightened to `number`.

Gate green: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` (41/41
turbo tasks; 371 apps tests incl. the new island-import, action-wiring, and
edit-filter tests).

## Boot

Production only (`next build && next start`, `NODE_OPTIONS=--max-old-space-size=3584`,
port 3100, never `next dev`). Cadence auth via a minted HS256 Supabase JWT
(`SUPABASE_JWT_SECRET`, aud+role `authenticated`, sub = Maya's seeded uuid) set
into cookie `sb-cadence-auth-token`. Keys from the gitignored `.env`, never
committed.

## Results

| # | prompt | verdict | evidence |
|---|--------|---------|----------|
| 5 | a revenue vs expenses summary with a chart | **PASS (caveat: figures)** | Full dashboard: 3 stat cards + a **dependency-free inline-SVG grouped bar chart ("Revenue vs Expenses — Monthly 2024") that RENDERS with bars** + a line chart. **No jail error box** (island imports no chart lib — the gate worked; contrast #385's empty chart / prior `recharts` box). Cadence has no revenue tool, so figures are illustrative, but the app **honestly disclaims**: "All figures are illustrative placeholder data for demonstration purposes only." `05-revenue-vs-expenses.png` |
| 6 | a new-client intake form | **PARTIAL (improved)** | Full 6-step intake wizard renders cleanly, **no error box**. Built as one client-only island (`IntakeForm`): `fetch:false`, `vendoAction:false`, references **no host tool** — it does NOT fake a host submit and does NOT leave a dead no-op button (Submit transitions to a confirmation state). Improvement over #385's handler-less dead Submit. **Caveat:** the confirmation copy ("Your intake form has been submitted… Maya Alvarez will be in touch") is optimistic — nothing is persisted (Cadence has no client-creation tool) — rather than a hard "no intake tool here" disclaimer. The prewired action-guard doesn't reach island-internal buttons; the guard's efficacy is shown by #4 + unit tests. |
| 4 | overdue invoices with a reminder button | **PASS** | Two independent confirmations. (a) **Raw create path** (`POST /api/vendo/apps`): six per-row **"Send Reminder"** buttons, each wired to the **mutating** tool `host_sendClientMessage` with a **payload binding the per-row `clientId`** (`$path:/deadlines/data/N/id`) + message — exactly the per-row context the payload guard requires (contrast #385's payload-less / blank-picker reminder). `04-overdue-invoices-app.json`. (b) **Browser chat run**: agent honestly grounds ("No invoice tools available… I'll build a self-contained Overdue Invoices mini-app"), renders a live tracker with per-row Send Reminder buttons that **fire** (badge Overdue→Reminder Sent, timestamp, "Reminders Sent" stat increments). `04-overdue-invoices-reminder.png`. |

**Bottom line: #4 PASS, #5 PASS (chart renders + no error box + honest
placeholder disclaimer), #6 PARTIAL (renders, no fake host wiring, no dead
button; confirmation copy optimistic).** The island import gate (#5) and the
action-payload guard (#4) are confirmed working end to end in a real browser and
via the create API. No regression; gate stays green.
