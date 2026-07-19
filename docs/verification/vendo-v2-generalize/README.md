# v2 generalization verification (anti-overfit)

Post-#381 check: 6 fresh prompts (3 Maple, 3 Cadence), none of them the tuned
bar prompt, driven through the real Apps create path in a real browser
(production `next start`, not dev). PASS = real app of host/prewired
components + real data or honest empty-state + working chart where asked +
no error-box/blob/raw-braces. No tuning between runs — fails reported as fails.

| # | host | prompt | verdict | note |
|---|------|--------|---------|------|
| 1 | demo-bank | spending breakdown by category this month with a chart | PASS | Real composed app: donut chart with real category segments + $471,711 total, Maple styling, no errors/islands. Caveat: companion table renders "No data" while the donut has data — same Table prop-name mismatch as #2. Note: app is a generated island (SpendingApp), not a prewired composition. `01-demo-bank-spending-breakdown.png` |
| 2 | demo-bank | a filterable list of recent transactions | FAIL | All-prewired branded composition (search + category/status filters with real Maple categories), query fetched 25 real rows — but the tree binds them to `data`, a prop the prewired Table doesn't have (`rows` is the contract; `header`/`render` column keys also wrong, labels fall back to lowercase keys). Renderer silently drops unknown props → permanent "No data" despite data. The #381 binding-vs-prop-schema compile check misses wrong prop *names*. Core ask (a transactions list) not delivered. `02-demo-bank-filterable-transactions.png` |
| 3 | demo-bank | a form to transfer money between two accounts | FAIL | Beautiful all-prewired branded form (from/to selects, amount, note, fee/arrival rows, submit) — but both account Selects render 4 BLANK options: tree passes `options:{$path:/accounts/data}` + invented `labelKey`/`valueKey` props; prewired Select's contract is `options:[{value,label}]`, so account objects (`id`/`name`) produce empty labels. Same invented-prop-contract class as #2 — account selection unusable. `03-demo-bank-transfer-form.png` |
| 4 | demo-accounting | overdue invoices with a reminder button | PASS | Cadence has NO invoice tools; model grounded honestly to real registry tools (clients past filing deadlines via `host_listClients`/`host_getDashboard`) instead of inventing `get_invoice_summary` like the pre-#381 run. Real seeded data (8 clients, real contacts/deadlines), stat hero card, per-row Send Reminder wired to `host_sendClientMessage` — fires and is correctly approval-gated with visible "waiting for approval" state. Caveats: onClick carries NO per-row args (clientId/body), so the send couldn't complete post-approval; raw ISO dates + raw `missing_docs` enum; table column alignment rough. Host-boot note: Cadence prod build needed `@electric-sql/pglite` added to `serverExternalPackages` (PGlite WASM broke under Turbopack chunking) — packaging fix, not generation tuning. `04-demo-accounting-overdue-invoices.png` |
| 5 | demo-accounting | a revenue vs expenses summary with a chart | FAIL | Error box on the surface: model emitted a generated island (`RevenueExpensesChart`) importing `recharts`, which the Vendo jail rejects — "module recharts is not available in the Vendo jail". Cadence has no revenue/expense tools, and instead of an honest empty-state (like #4 did) it reached for an island + external chart lib. Gap: the #381 island gate esbuild-checks syntax + default export at create but does NOT validate imports against the jail's module allowlist, so the app ships broken. Chart asked, chart not delivered. `05-demo-accounting-revenue-vs-expenses.png` |
| 6 | demo-accounting | a new-client intake form | FAIL | Visually the best of the six: 4-section prewired form (business info, contact, tax details, notes) with sensible fields and correctly-labeled static Select options, clean Cadence styling, zero errors. But it's a facade: "Save Draft" has NO action, "Submit Intake Form" is wired to `host_listClients` (a READ tool — semantically meaningless) via `onPress` (the branded Button dispatches `onClick`, so it may not even fire), and no field value is bound into any action payload. Cadence has no client-creation tool — the model promised a submission it cannot deliver instead of an honest static disclaimer. Fake affordance = core interaction not delivered. `06-demo-accounting-client-intake-form.png` + `06b-...-bottom.png` |

## Summary

**2/6 PASS (both with caveats), 4/6 FAIL.** The #381 fixes generalize on
*composition and grounding*: 5/6 apps were real prewired compositions (zero
raw-brace blobs, zero jail backtick-wrapper errors on the bank host), query tools
stayed inside the live registry, and #4 grounded an absent concept (invoices)
to real host data instead of inventing tools. They do NOT generalize on the
*component prop contract*: the dominant failure class (#1 caveat, #2, #3, #6)
is the model inventing plausible prop names (`data` vs `rows`,
`header`/`render` vs `label`, `labelKey`/`valueKey`, `onPress` vs `onClick`)
that the renderer silently drops — data fetches succeed, then the UI renders
empty/blank/no-op. Secondary gaps: island import validation missing from the
create gate (#5 recharts), and action payloads never carry per-row/form
context (#4, #6).

Fix direction (not applied here): strict prop-schema validation at compile
(reject unknown prop names on prewired components), jail-module allowlist
check inside the island gate, and payload-binding requirements for action-
bearing components.
