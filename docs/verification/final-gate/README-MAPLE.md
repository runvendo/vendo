# FINAL GATE — Maple half (scoring run)

Held-out scoring run per TASK-MAPLE.md. One attempt per prompt, zero tuning.
Host: demo-bank production (`next start`, port 3000), main @ 090b1779.
Judge bar: docs/eval/GOLDEN.md PASS bar. Timing = submit → app visible.
Repair flag = did structured repair visibly engage (slow first paint / retries)?

## Results

| id | prompt | verdict | timing | class-if-fail | repair? | note |
|----|--------|---------|--------|---------------|---------|------|
| M1 | show me my account balances at a glance | PASS | ~8s | — | no | Host balance card + 4 account cards, money formatted, no errors. Blemish: headline card label "Total balance" shows checking-only ($9,412.20 vs true total $54,907.15) — host component's baked-in label. |
| M2 | a dashboard of my monthly cash flow with income vs spending | FAIL | 19.1s | raw-cents (stat tiles) | no | Working bar chart (income vs spending) + donut + two formatted tables — but the three headline stat tiles render raw cents: "$642000", "$75373", "$5490715" (should be $6,420.00 / $753.73 / $54,907.15). Explicit PASS-bar violation. |
| M3 | list my upcoming scheduled payments and let me cancel one | PASS | 10.2s | — | no | Real table (Mission St Property -$2,850.00 Aug 1; PG&E -$86.40 Aug 15), formatted money+dates, searchable. Cancel = honest "Not available" disclaimer; verified host has no cancel tool (18 ops, listScheduledPayments only). Honest-handling PASS per bar. |
| M4 | a card spending tracker grouped by merchant | FAIL | 26.1s | empty-island (blank iframe) + wrong-aggregate | no | "Merchant Spend Summary" island renders as an empty iframe — ~800px blank region. Core ask (grouped by merchant) never delivered: flat txn table + category-only charts. Stat tile "Total Card Spend -$87.00" is wrong (single txn, not total). Table itself formatted + filters populated. |
| M5 | help me find any duplicate or suspicious charges | FAIL | 54.0s | ask-not-addressed (no detection logic) | possible (54s, slowest so far) | Header copy claims "We scan your recent transactions for potential duplicates, unusual amounts, and flagged patterns" — but body is a plain unfiltered table of ALL transactions (page 1 of 5), no duplicate pairs, no suspicion flags, no highlighting. Promises detection it doesn't do. Formatting itself clean. |
| M6 | a savings goal tracker for a $10,000 vacation fund | FAIL | 18.9s | wrong-data-binding (contradictory goal) | no | Subtitle: "Track your progress toward a $10,000 vacation goal" — but Goal Progress binds the existing $5,000 Japan-trip goal: "62%, saved $3,120.00 / target $5,000.00". Contradicts its own headline ($3,120 vs $10k = 31%). "Recent Savings Transactions" is actually groceries spending. Charts+formatting otherwise clean. |
