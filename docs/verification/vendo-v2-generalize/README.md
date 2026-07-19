# v2 generalization verification (anti-overfit)

Post-#381 check: 6 fresh prompts (3 Maple, 3 Cadence), none of them the tuned
bar prompt, driven through the real Apps create path in a real browser
(production `next start`, not dev). PASS = real app of host/prewired
components + real data or honest empty-state + working chart where asked +
no error-box/blob/raw-braces. No tuning between runs — fails reported as fails.

| # | host | prompt | verdict | note |
|---|------|--------|---------|------|
| 1 | demo-bank | spending breakdown by category this month with a chart | PASS | Real composed app: donut chart with real category segments + $471,711 total, Maple styling, no errors/islands. Caveat: companion table renders "No data" while the donut has data — row-binding miss on the secondary component. `01-demo-bank-spending-breakdown.png` |
