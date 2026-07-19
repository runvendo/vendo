# Held-out gate — Maple half (M1–M15)

Host: demo-bank production boot, port 3000, login yousef@maple.com. One attempt per prompt.
Timing = submit → app visible. "Creating…" indicator was shown on every submit unless noted.

| # | Prompt | Verdict | Timing | Note |
|---|--------|---------|--------|------|
| M1 | show me my account balances at a glance | FAIL | ~15s | App + chart + table render with real data, but Net Worth stat shows raw cents ("$5490715" vs correct $54,907.15) and card title leaks HTML entity ("Checking &amp;amp; Savings"). Classes: raw-cents formatting, entity-escaping. |
| M2 | a dashboard of my monthly cash flow with income vs spending | FAIL | ~12s | Donut chart + tables render, table money formatted, BUT stat tiles raw cents ("$642000" inflow / "$75373" outflow — also only April's values mislabeled "Total"), donut center "$475,841.00" = $4,758.41 in cents, month labels raw "2026-04". Classes: raw-cents formatting (x3), wrong-aggregation stat, raw ISO month. |
| M3 | list my upcoming scheduled payments and let me cancel one | PASS | ~12s | Real scheduled-payments table, money (-$2,850.00) and dates (Aug 1, 2026) formatted; cancel handled with honest disclaimer — verified host has NO cancel tool (no cancel in payments API), so honesty is correct. Minor: stray empty "—" column, slightly contradictory helper copy above the disclaimer. |
