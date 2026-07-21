# V4 FINAL GATE — Maple half (scoring run, 2026-07-21)

Official v4-wave scoring run. One attempt per prompt, zero tuning, production boot
(`next start`, port 3000), main @ e6dbfe40 + gate branch `eval/v4-final-gate`
(candidate config: `pipeline: { promptRewrite: true, endPass: true }` in both hosts,
committed before the first prompt; onPipeline server-log diagnostics, pure reporting).
Prompts: M1–M15 (frozen 30) + F1–F5 (Tranche 2) + G1–G5 (Tranche 3, authored blind
pre-gate — first commit of this branch).

Judge bar: docs/eval/GOLDEN.md PASS bar. Browser: dedicated headless Chromium
(Playwright 1.61.1, 1440x900), never shared. Timing = submit (Create click) → app
visible (first rendered content in the open-app region, text-settle confirmed;
full-page screenshot taken after settle). Repair engagement read from the onPipeline
server log (`repair` events) — no more timing guesswork. End-pass adoption =
`end-pass applied` per create, same log.

## Results

| id | prompt | verdict | timing | class-if-fail | repair? | end-pass | note |
|----|--------|---------|--------|---------------|---------|----------|------|
| M1 | show me my account balances at a glance | PASS | 5.6s | — | no | applied | Headline "TOTAL BALANCE $54,907.15" is the TRUE all-accounts total (the 2026-07-20 run's checking-only blemish is gone), trend chart, 4-account table all formatted ($9,412.20 / $28,141.35 / -$1,288.40 / $18,642.00). No errors. |
| M2 | a dashboard of my monthly cash flow with income vs spending | FAIL | 8.1s | wrong-data-binding (stale-period headline tiles) | no | applied | The baseline raw-cents class is GONE — tiles render "$6,420.00"/"$753.73" formatted. But those are the OLDEST period's numbers (2026-04), while the donut/table/bars show July ($4,845.30 spending): "Monthly income/spending" headline binds a stale period. Charts + tables otherwise real and formatted. |
| M3 | list my upcoming scheduled payments and let me cancel one | FAIL | 50.3s | capability-claim (cancel wired to host_transferMoney with an EMPTY payload) | yes (2 rounds, repaired, 4.1s) | applied | Table itself is right (Mission St -$2,850.00 Aug 1; PG&E -$86.40 Aug 15) and the Select is populated real ("PG&E — -$86.40 — Aug 15, 2026"). It even discloses "No dedicated cancel-scheduled-payment tool" — then still ships a Cancel button that fires `host_transferMoney {"amount":0,"memo":"","recipient_name":""}` (M03c) claiming the "cancellation request rides the transfer action". Baseline PASSed here with a pure honest disclaimer; this run REGRESSED into a miswired zero-dollar transfer. Denied at the approval gate. |
| M4 | a card spending tracker grouped by merchant | FAIL | 33.1s | wrong-data-binding (wrong aggregate + wrong scope) | yes (1 round, repaired, noValidFix 2, 1.8s) | applied | The baseline's blank island is GONE: a real 28-merchant grouped table (spend/visits/last-charge, sortable By spend/visits/recent, search) + a formatted "Detected recurring charges" table. But the headline "Total spent this period $2,850.00" contradicts its own table (July rows alone exceed it several-fold), the other two stat tiles render placeholder "—" (set-but-unrenderable Stat now shows the designed placeholder — better than raw cents, still empty), and a CARD tracker lists Acme Corp Payroll income ($38,520.00) and checking/savings transfers as "merchants". |
| M5 | help me find any duplicate or suspicious charges | PASS | 33.3s | — | no | applied | Baseline's "claims detection, renders plain list" is fixed: real detector tabs "Possible duplicates (0)" / "Unusual amounts (0)" with an honest all-clear empty state — verified against the seed (no duplicate pairs exist, so 0 is TRUE) — plus a filterable/searchable all-transactions table, money+dates formatted, populated selects, no errors. |
| M6 | a savings goal tracker for a $10,000 vacation fund | PASS | 24.9s | — | no | applied | Baseline's contradictory binding is fixed: hero tracks $3,120.00 saved of the ASKED $10,000.00 (31%, "$6,880.00 to go" — internally consistent), milestone row at 25/50/75/100% of $10k, and the underlying real goals disclosed truthfully below (Japan trip saved $3,120 / target $5,000; Emergency fund; New MacBook). All money formatted, no errors. Wart: literal icon token "plane" renders as text next to JAPAN TRIP. |
| M7 | compare my spending this month vs last month | FAIL | 30.2s | empty-chart + wrong-aggregate tiles | no | applied | REGRESSION (baseline PASS). Headline tiles read "This month (Jul 1–21) $0.36" / "Last month (Jun 1–30) $0.51" — broken aggregates at cents scale — the "Spending by category" comparison bar chart renders EMPTY (legend + axis, zero bars; a chart was the ask), and "Total change +$15.95 vs last month" contradicts the real ~$150 delta. The donut ($4,845.30, correct) and the formatted July transactions table are fine. |
| M8 | a quick-transfer widget for moving money to savings | PASS | 39.9s | — | no | not applied | From/To rendered as real accounts with live balances (Maple Checking $9,412.20 → Maple Savings $28,141.35), quick chips $25–$250, memo. Balance card badge truthfully says "Checking balance" (baseline's mislabel class absent). Fired $50 → "Awaiting your approval… $50.00 to Maple Savings" with full payload `host_transferMoney {"amount":5000,"memo":"Transfer to savings","recipient_name":"Maple Savings"}` (M08b) — approval-gated PASS; denied after capture. |

## Summary

(run in progress)
