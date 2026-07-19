# FINAL 6-case gate — merged main (#385+#386+#387+#388)

Same 6-prompt matrix as docs/verification/vendo-v2-propschema, driven through the
real Apps create path in a real browser, production boot (`next build && next start`,
`NODE_OPTIONS=--max-old-space-size=3072`). Arc: 2/6 (generalize) → 2/6 (propschema) → this run.
No tuning between prompts; fails reported as fails.

| # | host | prompt | verdict | timing | note |
|---|------|--------|---------|--------|------|
| 1 | demo-bank | spending breakdown by category this month with a chart | PASS | complete ≤16s observed (submit→full app; "Creating…" still shown at ~5s; no partial paint observed in surface) | Real composed app: **host donut chart** (`MapleSpendingDonut`, `source:host`, slices via `$path:/spending/data`) renders real category segments + prewired Table (`rows` + `$path`) populated with 7 real category rows. **FORMATTING CLASS FIXED in the tree: all table amounts are real dollars — housing $2,850.00, shopping $617.49, transport $562.06, subscriptions $335.47, dining $236.70, groceries $126.61, coffee $30.08** (prior run: raw cents 285000/61749/…, "AMOUNT (CENTS)"). Column headers correct. Caveat: the donut's center TOTAL shows **$475,841.00** — the host component sums the cents-denominated slices and renders as dollars (true total $4,758.41); units seam inside the HOST component's own total, not the generated tree (table ✓). No error box, no raw braces. `01-demo-bank-spending-breakdown.png`, `01b-demo-bank-spending-breakdown-table.png` |
