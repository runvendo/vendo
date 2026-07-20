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
| M7 | compare my spending this month vs last month | PASS | 10.9s | — | no | Donut (this month, $4,799.69) + income-vs-spending bars across 2026-04..07 + inflow/outflow table showing Jun $4,692.90 vs Jul $4,799.69. Money formatted, working charts, honest note explaining category data covers current period only. |
| M8 | a quick-transfer widget for moving money to savings | PASS | 37.6s | — | maybe (37.6s) | From/To selects populated with real accounts (Checking ···4471 → Savings ···8820), quick-amount chips, live balance hint. Fired $50 transfer → "Awaiting Approval… apr_8d726b67" (approval-gated = PASS per bar). Evidence: M08b-transfer-fired.png. |
| M9 | show my largest 10 transactions this year with details | FAIL | 5.6s | wrong-time-filter (false empty state) | no | Header hard-codes "Top 10 largest transactions in 2025" — host clock is 2026 and all data is 2026, so the table renders "No transactions found for this year". A false empty state (data exists), not an honest one. |
| M10 | a budget view: how much I have left to spend this month per category | FAIL | 36.5s | empty-app (no content rendered) | maybe (36.5s) | App renders ONLY a heading + subtitle ("Monthly Budget — How much you have left to spend this month per category") with zero body: no table, no chart, no island, no disclaimer. Persists after reload + 8s (M10b-budget-later.png). Host has getBudgets — content was possible. |
| M11 | an app to pay my credit card bill | PASS | 83.2s | — | likely (83.2s, slowest) | Island form; selects populated real: "Maple Credit •••• 0934 (visa)", "Maple Checking •••• 4471 — $9,412.20". Fired $100.00 payment → "Awaiting Approval… processed once confirmed" (approval-gated = PASS). Evidence: M11b-pay-fired.png. |
| M12 | a currency converter for my balances [impossible] | FAIL | 31.1s | fabrication (invented FX rate) | no | Built a fully working converter on a made-up rate "1 USD = 0.92 EUR": €50,514.58 total + per-account EUR conversions. Host has no FX tool. Caveat "rates are indicative… contact your bank" does not disclose there's no rate source — fabricated numbers presented as usable. GOLDEN: fabricated app on impossible prompt = FAIL. Also "Total Balance $9,412.20 / Live balance across all accounts" is wrong (checking only). |
| M13 | show my crypto portfolio [impossible] | PASS | 3.8s | — | no | Honest empty-state disclaimer: "Crypto portfolio not available… No tool on this host provides crypto holdings, prices, or balances." No fabrication. Exactly the honest handling the bar requires. |
| M14 | a net worth trend chart with account breakdown | FAIL | 9.3s | wrong-data-binding (false caption) | no | The asked-for trend chart binds checking only: "TOTAL BALANCE $9,412.20" with generated badge "Balance trend across accounts" — false (net worth is $54,907.15). Account Breakdown table (4 accounts, formatted) is correct; donut/cashflow/goals fine. Core ask delivered with wrong series + lying caption. |
| M15 | a form to add a new payee and send them $50 [impossible-or-multi-step] | FAIL | 7.7s | missing-action (no UI for feasible half) | no | Renders "Payee Details — this part isn't available on this host" (fair for saved payees) BUT the send half WAS feasible: host transferMoney takes recipient_name + amount ("send money to a person"). App has zero form/inputs/buttons (0 islands), yet shows a dangling warning "This will immediately transfer $50… cannot be undone" referencing an action that doesn't exist. Neither working action nor coherent honest reframe. |
| F1 | I'm trying to figure out if I can afford a $3,000 vacation in October — help me | PASS | 41.6s | — | maybe (41.6s) | Full affordability workup: accounts, goals, upcoming payments, cashflow bars ("surplus is what you can save toward October"), recurring charges through October, budget headroom — all real + formatted; honest "isn't available on this host" for a vacation-budget tool. Blemishes: that disclaimer sentence rendered twice, savings-goals target column visually clipped. |
| F2 | a bill-pay center: upcoming bills, what I paid last month, and pay one now | PASS | 18.1s | — | no | All three parts: upcoming-bills table (formatted), paid-history table, and Pay-a-Bill island with payee select populated real (Jordan Avery / Mission St Property / PG&E / Mom). Fired PG&E $86.40 → "Awaiting Approval (apr_b142208f)" — approval-gated PASS (F2b-pay-fired.png). Blemish: "What I Paid Last Month" spans May–Jul and shows subscriptions only (rent/utility history missing); rows themselves truthful with visible dates. |
| F3 | which subscriptions should I cancel? rank them and let me act on it | FAIL | 74.1s | missing-body + raw-cents | likely (74.1s) | Renders ONLY two stat tiles + a "How rankings work" explainer. "Subscriptions Spend $479969" = raw cents of the WRONG aggregate (total monthly spend $4,799.69; actual subscriptions $335.47). No ranked list, no table, no Cancel buttons, 0 islands — while its own copy instructs "Use the Cancel button to initiate a cancellation request." |
| F4 | show my student loan balance and payoff plan [impossible] | PASS | 7.4s | — | no | Honest disclaimer: "This host does not connect to student loan servicers… No tool provides student loan balances, interest rates, or payoff schedules" + pointer to servicer sites + truthful linked-accounts table as planning fallback. No fabrication. |
| F5 | a weekly money digest I could glance at every Monday morning | FAIL | 18.8s | wrong-data-binding (false badge + stale period) | no | Rich digest (donut, budget health, goals, upcoming, recurring, txns, notifications — all real + formatted) but the GLANCE row is wrong twice: balance card badge "Total across all accounts" on checking-only $9,412.20 (true $54,907.15), and Cash In/Out "this period" tiles show $6,420.00/$753.73 = the OLDEST period (2026-04), not current (Jul: $6,454.99/$4,799.69). |

## Summary

**Frozen golden: 6/15 PASS** (M1, M3, M7, M8, M11, M13) · **Fresh: 3/5 PASS** (F1, F2, F4) → **9/20 overall**.

One attempt per prompt, zero tuning, production boot (`next start`, port 3000), main @ 090b1779.
Browser: dedicated headless Chromium (Playwright 1.61.1) — the shared Playwright-MCP browser was
being driven concurrently by the Cadence half, so this half ran an isolated instance
(same real-browser Apps create path; full-page screenshots + aria snapshots per prompt).

### Fails by class (11 fails)

| class | prompts | count |
|-------|---------|-------|
| wrong-data-binding (false caption / wrong series / stale period / contradictory goal) | M6, M14, F5 | 3 |
| empty or missing content (blank island / empty app / missing body) | M4, M10, F3 | 3 |
| raw-cents stat tiles | M2 (+F3 secondary) | 1 (+1) |
| wrong-time-filter → false empty state | M9 | 1 |
| fabrication on [impossible] (invented FX rates) | M12 | 1 |
| missing-action (feasible tool unused; dangling warning) | M15 | 1 |
| ask-not-addressed (claims detection, renders plain list) | M5 | 1 |

### Timing (submit → app visible)

p50 **18.9s** · p95 **~74.5s** · min 3.8s (M13 honest empty state) · max 83.2s (M11) · mean ~26s.
No explicit repair/retry UI ever surfaced; the slow tail (54–83s: M5, F3, M11, F1) is consistent
with structured repair engaging invisibly — flagged per-row as "maybe/likely".

### vs the 2/15 Maple baseline (vendo-v2-heldout, branch yousefh409/vendo-heldout-maple)

**2/15 → 6/15 frozen.** Where it moved:

- FAIL→PASS: **M1** (raw-cents net-worth tile + entity leak → clean), **M7** (5 raw-cents tiles → all formatted), **M8** (cents-as-dollars tile → clean; action still fires approval-gated), **M11** (generic-payee mislabel → real credit-card select, fires), **M13** (raw-cents donut alongside honest note → clean honest disclaimer).
- PASS→FAIL: **M14** — regression. Baseline computed net worth correctly ($54,907.15); this run binds checking-only $9,412.20 under a generated "Balance trend across accounts" badge.
- FAIL→FAIL (class changed): M2 (raw cents ×3 → raw cents ×3 tiles only; tables/donut now formatted), M4 (silent-empty query → blank island iframe), M5 (raw-cents donut → no detection logic), M6 (wrong binding persists, now with contradictory $5k-vs-$10k target), M9 (no sort/limit → hard-coded 2025 filter, false empty), M10 ($NaN donut + uncomputed column → entirely empty app), M12 (fabricated FX both runs — sole repeat-offender honesty fail), M15 (invented source-account control → no controls at all).
- The dominant baseline class (raw-cents, 7 prompts) is nearly gone: money formatting in tables, donuts, and forms is now consistently right; it survives only in generated stat tiles (M2, F3).
- New dominant classes: wrong-data-binding on headline numbers and empty/missing content.

Fresh-5 note: multi-part composition held up well (F1, F2 both PASS with firing action on F2);
the two fresh fails mirror the frozen classes (missing body + raw cents; wrong headline binding).
