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
