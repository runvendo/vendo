# v2 end-to-end verification — live run on merged main (2026-07-18)

Verification of the merged v2 build (Waves 1–4: #369, #375, #374, #377) with REAL
generations. `main @ 884a118d`, `pnpm install && pnpm build` clean.

## What ran

The corpus gallery was skipped: `corpus/.repos` has no checkouts (deleted in the
2026-07 disk cleanup), so `pnpm corpus gallery` would clone + bootstrap 16 repos.
Fallback per plan: demo-bank (Maple) on `next dev`, real Anthropic keys, model
`claude-sonnet-4-6`, paint lane `claude-haiku-4-5`.

Three real generations:

1. **Chat/wire path** (`POST /api/vendo/threads`, streaming): "overdue invoice
   dashboard with a revenue chart and a reminder button" →
   `live-run-timeline.txt`.
2. **Apps-form path** (`POST /api/vendo/apps`, single-lane): same ask, plus an
   explicit "use host components and live host data via queries — do not
   hardcode data" → `browser-render-contained-error.png`, app doc quoted below.
3. (Previous session, same engine: a simple "greeting card" ask succeeds and
   renders; simple asks are fine.)

## What WORKS

- **The v2 pipeline is mechanically sound end-to-end.** Real model output →
  wire → compiler → validated `vendo-genui/v2` document → stored → opened →
  dispatched by the registered v2 renderer. Every streamed view carried
  `formatVersion: vendo-genui/v2`. Create returned 200 and the app persisted on
  both paths.
- **Tier0-wired streaming is real.** Timeline: create tool at 5.4s, the paint
  lane streams a fully-wired 37-node tree from 15.4s→20.7s (≈10s from
  create-tool start, including model spin-up), then the full lane replaces it
  (final view at ~110s). Valid-while-partial holds — every prefix rendered as a
  valid tree.
- **Failure is contained.** The broken generated island renders as one
  contained notice inside the app surface; the host page never crashes or goes
  blank.

## What FAILS (the point of this verification)

**The headline check — "a chart bound to a tool response is NOT broken/empty" —
FAILS on every dashboard-class ask (3/3 today, plus 2/3 in the prior session).**

1. **The model routes everything into one generated island, and the island is
   malformed.** Both runs produced `root Stack → <one big island>`; the island
   source begins with `\n{`` ` `` (the model wraps the TSX in a JSX
   template-literal expression). The jail rejects it — browser shows
   `OverdueDashboard: generated component must have a React default export`
   (screenshot) — so the rendered "app" is a contained error notice, not a
   dashboard. Nothing validates island syntax at create time (no esbuild/
   default-export check in the engine), so these documents pass validation and
   persist broken.
2. **Shape-aware binding (Wave 3) is inert in the product.** `toolShapes`
   exists on `GenerationDependencies` and the compiler enforces it — but no
   caller produces it: `generationDependencies()` in `packages/apps/src/runtime.ts`
   never passes it, `createVendo` has no shape-card plumbing, and `vendo sync`
   derives no shapes. Grep confirms the only `toolShapes` references are the
   engine/compiler themselves.
3. **Query tools are not validated against the live tool registry.** The
   apps-form run declared queries against invented tools —
   `get_invoice_summary`, `get_revenue_history`, `list_invoices` — none of
   which exist on Maple (`host_*`). Validation only checks `fn:` grammar, so
   the document persists with dead queries and `data` stays empty; the wire
   run's island instead hardcoded fake invoice data (see
   `live-run-final-payload.json`).
4. Secondary: the tier-0 paint emitted islands despite the PAINT PASS contract
   ("NO islands"), failed validation, and therefore never became the resident
   fallback — so the anti-regression suppression didn't engage and the surface
   regressed to 1 node at 37.2s mid-upgrade.

## Files

- `live-run-timeline.txt` — SSE view/tool timeline of the chat-path run.
- `live-run-final-payload.json` — final v2 payload: 2 nodes, one 18.9KB island,
  hardcoded `INVOICES`, no queries.
- `browser-render-contained-error.png` — the Apps page after the browser-path
  create: app exists, surface = contained island error.

## Suggested follow-ups (not done here)

- Wire shape cards end-to-end: derive shapes at `vendo sync`/from tool
  descriptors → `AppsConfig.toolShapes` → `generationDependencies`.
- Validate query tool names against the live tool registry at create.
- Syntax-check island sources at create (esbuild transform + default-export
  check) and route failures to the repair loop; also strip the model's
  `{`…`}` island wrapper the way `extractWire` strips fences.
- Prompt-side: push composition of catalog/prewired components over monolithic
  islands (the island-heavy output is what makes every other guard moot).

## FIXED (branch yousefh409/vendo-v2-fixes, 2026-07-18)

Re-ran the same bar prompt ("overdue invoice dashboard with a revenue chart
and a reminder button") on demo-bank after the integration fixes. The surface
now renders a REAL dashboard — `fixed-dashboard.png` / `fixed-dashboard-2.png`:

- Composed of host + prewired components, ZERO islands: four Stat cards with
  live host data (Total Accounts 4, Net Worth 5490715, Scheduled Payments
  -285000), the MapleNetWorthCard host chart DRAWING a real sparkline
  ($54,907.15), the MapleSpendingDonut rendering ($500.00 total), and two
  working reminder buttons. No contained-error box, no comment noise, no raw
  brace syntax. (The invoice tables honestly show "No data" — Maple's seed
  data has no overdue-invoice records.)

What made the difference (see the PR for the full list): composition-first
prompt with islands as a last resort; island syntax gate (wrapper strip +
esbuild + default-export) routed to repair; shape cards sampled live from
read tools feeding both the prompt and the compiler's binding type-check;
query tools validated against the live registry; binding-kind vs prop-schema
check; numeric path segments in the expression grammar; compiler-level HTML
comment skipping; string-interpolation guard; streaming error boundaries
reset when data arrives (a mid-stream crash no longer latches over the
resolved app).
