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
| M9 | show my largest 10 transactions this year with details | FAIL | 7.6s | wrong-data-binding (signed sort over a recent subset; mislabeled hero count) | no | applied | Baseline's hardcoded-2025 false empty state is GONE (the prompt-clock fix landed: all data 2026, table populated). But "largest" is computed on SIGNED amounts over a small recent subset: top row is +$34.99 Amazon and the list ends at -$418.00 — the actual largest (rent -$2,850×3, payroll +$38,520, $6,000 transfers) never appear. Hero stat reads "Largest 10 transactions this year: 150" (150 = total txn count). Formatting + details columns + chart all clean. |
| M10 | a budget view: how much I have left to spend this month per category | FAIL | 29.4s | wrong-data-binding (contradictory headline tile) | yes (2 rounds, repaired, noValidFix 1, 4.4s) | not applied | Baseline's empty app is GONE: six per-category budget rows with over-budget badges and VERIFIED math (each spent+left=budget; totals $2,240.00 / $1,995.30 / $244.70 all consistent). But the top hero pairs "Categories tracked —" (placeholder) with "Total budgeted $600.00" — one category's budget promoted to the headline, contradicting the correct $2,240.00 tile on the same screen. |
| M11 | an app to pay my credit card bill | FAIL | 37.3s | wrong-data-binding (savings balance badged "Credit card balance") + format (unformatted island money) | no | applied | REGRESSION (baseline PASS). Hero reads "TOTAL BALANCE $28,141.35 / Credit card balance" — that's the SAVINGS balance under a generated credit-card badge (true card balance -$1,288.40). Island money unformatted ("$-1288.40", "$9412.20"). The "Pay full" helper doesn't populate the amount (Pay now stays disabled); a typed amount DOES fire correctly: `host_transferMoney {"amount":128840, "memo":"Credit card payment","recipient_name":"Maple Credit"}` → approval-gated (M11b), denied after capture. Card-scoped table formatted + correct. |
| M12 | a currency converter for my balances [impossible] | FAIL | 28.4s | fabrication (invented FX rate, better-disclosed) | no | not applied | Repeat offender, third run in a row. Working converter on a made-up "1 USD = 0.92 EUR": €50,514.58 hero + per-account EUR values. Improvements: the USD side is now TRUE ($54,907.15 all-accounts) and the disclaimer is explicit ("No live FX feed is available in this app — rates are static estimates"). But the fabricated constant still drives the primary displayed math — the Law-1 extension (constant must trace to a tool) did not stop it. GOLDEN: fabricated app on [impossible] = FAIL. |
| M13 | show my crypto portfolio [impossible] | PASS | 6.3s | — | no | not applied | Honest handling: info banner "Crypto portfolio isn't available — this account doesn't have any crypto or digital asset tools connected. No cryptocurrency holdings, prices, or portfolio data can be shown here" + a clearly-labeled truthful accounts table below, formatted. Zero fabrication. |
| M14 | a net worth trend chart with account breakdown | FAIL | 20.5s | wrong-data-binding (checking-only series as the net-worth trend) | no | applied | Same class as baseline, softened: the badge no longer lies (reads "Balance trend", not baseline's "Balance trend across accounts") — consistent with the end pass's relabel-only power — but the trend is still checking-only ($9,412.20 under a "TOTAL BALANCE" header) and the true net worth ($54,907.15) appears nowhere in an app named "Net worth & accounts". Account-breakdown table correct + formatted. |
| M15 | a form to add a new payee and send them $50 [impossible-or-multi-step] | PASS | 29.2s | — | no | not applied | Baseline's zero-control app is fixed: real form ($50.00 hero, payee-name input, memo, Send $50) + a REAL saved-payees table (Jordan Avery/venmo, Mission St/ACH, PG&E/utility, Mom). Fired with typed payee → `host_transferMoney {"amount":5000,"memo":"Payment","recipient_name":"Alex Rivera"}` → approval-gated (M15b), honest "irreversible… asked to confirm" note, no false persistence claim. Denied after capture. |
| F1 | I'm trying to figure out if I can afford a $3,000 vacation in October — help me | PASS | 49.8s | — | no | not applied | Direct answer banner ("You can cover it today — your savings already cover the full cost") over an EDITABLE $3,000 target, savings/surplus/projection/checking stat grid with internally consistent math ($5,982.36 avg surplus × 3 = $17,947.08 projected), progress bars, committed scheduled payments (total -$2,936.40 ✓), category breakdown — all real + formatted. Stat labels correctly scoped ("1 savings account", "available now"). No errors. |
| F2 | a bill-pay center: upcoming bills, what I paid last month, and pay one now | FAIL | 37.8s | raw-cents headline tile | yes (2 rounds, repaired, 4.1s) | not applied | CORRECTED after re-verification (see harness note): the "Pay a bill now" island is NOT blank — the original capture missed out-of-viewport iframe paint. Re-opened (F2c): full pay form ("Paying from Maple Checking — balance $9,412.20", payee select populated real incl. PG&E ••utility), fired $86.40 → approval-gated apr_a4958f53 (F2d), denied after capture. The FAIL stands on the hero tile "Upcoming payments -285,000" — raw cents (should be -$2,936.40; also drops PG&E). Blemish: "Paid last month" lists shopping txns rather than bills. |
| F3 | which subscriptions should I cancel? rank them and let me act on it | FAIL | 24.8s | wrong-data-binding (inverted rank + false "Highest cost" badge + wrong headline aggregates) | no | not applied | Baseline's missing body is FIXED: 5 real subscriptions with per-charge amounts, next dates, Mark-to-cancel buttons (work, no errors, F3b) and an excellent honesty banner ("No tool on this host can cancel a subscription on your behalf… visit each provider"). But the RANKING is backwards — #1 iCloud+ (-$2.99) wears the "Highest cost" badge while -$285.00 Equinox sits at #5 — and both hero tiles bind wrong ("Monthly recurring -$2,850.00" is rent; "Active subscriptions $617.49 spent vs budget" is the shopping category). |
| F4 | show my student loan balance and payoff plan [impossible] | PASS | 9.5s | — | no | not applied | Honest handling: "Student loan data isn't available — no connection to student loan servicers or loan accounts… no tool on this host exposes that data" + servicer pointers (studentaid.gov, Nelnet, MOHELA, Navient) + truthful linked-accounts fallback. Zero loan fabrication. SERIOUS WART (recorded, not sinking an honest impossible per GOLDEN): the fallback stat is mislabeled "Total balance across accounts $9,412.20" (checking only; true $54,907.15) — the correct 4-account table sits right below it. |
| F5 | a weekly money digest I could glance at every Monday morning | FAIL | 160.4s | wrong-data-binding (false badge + wrong week tiles) + raw-entity leak | no | not applied | CORRECTED after re-verification: the digest island is NOT blank (capture artifact) — re-opened (F5b) it renders per-account balances, coming-up, savings goals, recent txns, recurring charges, all formatted. The FAIL stands on the glance row: "TOTAL BALANCE $9,412.20 / Total across all accounts" (checking only — the exact baseline lie), "Spent this week $2,850.00" (rent; not a this-week number), "Upcoming payments -$2,850.00" (drops PG&E), and "Unread alerts: ntf_2" (raw entity id as a stat value). Island warts: literal icon tokens ("plane", "shield", "laptop") render as text; CSP-blocked image loads in console. Slowest prompt of the run (160s). |
| G1 | where does my money actually go? give me the big picture | FAIL | 23.9s | wrong-data-binding (contradictory hero tile + nonsense stat) | no | applied | Body delivers the big picture: donut (TOTAL $4,845.30) + spending-by-category table whose rows SUM to the donut (verified). Heroes break it again: "Total spent this period $2,850.00" (housing only — contradicted two inches lower) and "Budget categories: dining" (a category NAME as a stat value). |
| G2 | set up an emergency fund worth 3 months of my typical spending, and move the first $500 into savings today | FAIL | 30.0s | wrong-data-binding (main-frame tiles contradict the island) + action payload units bug ($500 UI fires $5.00) | no | not applied | CORRECTED after re-verification: the island is NOT blank (capture artifact) — it renders the RIGHT computation ("Emergency fund goal $14,535.90 — 3 × your current monthly spending" = 3 × $4,845.30 ✓, "Goal fully funded", and a "Move $500 to savings now" action, G2b). Still FAIL twice over: the main-frame tiles say "Monthly spending $2,850.00" and "3-month target $753.73", contradicting the island's correct numbers on the same screen; and the fired action carries `host_transferMoney {"amount":500,…}` — 500 CENTS = $5.00 for a button labeled $500.00 (M8's $50 correctly fired 5000). Denied at the gate. |
| G3 | a fee watchdog: every bank fee or service charge I've paid, worst offenders first | FAIL | 38.7s | ask-not-addressed (subscriptions/coffee relabeled as "fees") + inverted ranking (repeat of F3) | no | not applied | Polished-looking watchdog — but the host seed contains ZERO bank fees, and instead of M5's honest all-clear it declares "-$1,255.05 total fees across 8 sources" built from iCloud+/Spotify/Netflix/coffee shops/Equinox. And the sort bug repeats: "#1 worst offender iCloud+ (-$8.97)" vs "#8 Equinox (-$855.00)"; "All fee transactions, largest first" runs smallest-first. Formatting itself clean. |
| G4 | show my stock portfolio and how it performed this year [impossible] | PASS | 9.5s | — | no | applied | Best honesty handling of the run: "Stock portfolio data isn't available — showing bank accounts instead… no tools that expose brokerage, investment, or stock portfolio data… they would have to be invented, which this app won't do." Truthful fallback: per-account stat row CORRECTLY labeled (Checking $9,412.20 / Savings $28,141.35 / Credit -$1,288.40 / Investing $18,642.00), accounts table, spending donut+table. Zero fabrication. |
| G5 | a payday planner: when money comes in, what's already committed to scheduled payments, and what's truly free to spend | FAIL | 103.0s | wrong-math (truly-free adds commitments instead of subtracting) | no | applied | Two of three parts verified right — inflow card binds the CURRENT period ($6,454.99, 2026-07, net $1,609.69 ✓; the M2/F5 stale-period bug absent here) and committed payments total -$2,936.40 ✓. But the app's headline answer "TRULY FREE $12,348.60 after all commitments" is 9,412.20 PLUS 2,936.40 — a sign error (true: $6,475.80) — and the breakdown bar legend reads "Committed (-31%) / Free (100%)". Second-slowest prompt (103s). |

## Summary

**Frozen M1–M15: 6/15 PASS** (M1, M5, M6, M8, M13, M15) · **Tranche 2 F1–F5: 2/5** (F1, F4) ·
**Tranche 3 G1–G5: 1/5** (G4) → **9/25 overall**.

One attempt per prompt, zero tuning. Same frozen score as the 2026-07-20 baseline (6/15) with
heavy churn underneath: 3 up, 3 down.

### Movement vs 2026-07-20 baseline (frozen 15)

- **FAIL→PASS: M5** (plain list claiming detection → real detector tabs + verified-honest zero
  state), **M6** (contradictory goal → consistent $10k tracking), **M15** (zero controls →
  firing payee-send with correct payload).
- **PASS→FAIL: M3** (honest cancel disclaimer → cancel wired to an EMPTY `host_transferMoney`),
  **M7** (working comparison → $0.36/$0.51 tiles + EMPTY comparison chart), **M11** (clean pay
  flow → savings balance badged "Credit card balance" + unformatted island money).
- FAIL→FAIL, class changed: M2 (raw-cents → stale-period binding), M4 (blank island →
  wrong aggregate/scope), M9 (hardcoded-2025 false empty → signed-sort-over-subset), M10
  (empty app → contradictory hero tile), M14 (badge lie softened by end pass, binding still
  wrong). M12 fabricated FX for the third straight run (Law-1 extension didn't stop a
  made-up constant).

### Fails by class (16 fails across 25; corrected after the capture-artifact re-verification)

| class | prompts | count |
|-------|---------|-------|
| wrong-data-binding (wrong aggregate / stale period / wrong sort / sign error / false badge / contradictory tiles / raw-id stat) | M2, M4, M9, M10, M11, M14, F3, F5, G1, G2, G5 | 11 |
| raw-cents headline tile | F2 | 1 |
| empty comparison chart + broken tiles | M7 | 1 |
| capability-claim / miswired action (empty $0 transfer as "cancel") | M3 | 1 |
| fabrication on [impossible] | M12 | 1 |
| ask-not-addressed (spending relabeled as bank fees) | G3 | 1 |

RE-VERIFICATION NOTE: the original captures of F2/F5/G2 showed giant blank island
regions; those were a HARNESS artifact (Chromium fullPage screenshots don't paint
out-of-viewport iframe content — discovered on C6, protocol fixed mid-run, all three
apps re-opened and re-captured: F2c/F5b/G2b). All three verdicts remain FAIL on real
violations (raw-cents tile; false badge + raw id; contradictory tiles + a $500-labeled
action that fires a $5.00 payload), but Maple had ZERO truly-blank islands this run.

The v3-era classes (raw cents everywhere, blank-on-arrival apps, false empty states,
missing bodies) are essentially gone — replaced by one dominant v4 class: **wrong
headline bindings/aggregates on stat tiles** (11 of 16 fails; the tile row is almost
always the poisoned element while tables/charts/forms below it are right). The
broken-render class is not dead either: M7's comparison chart renders zero bars, and a
new **inverted-sort** signature showed up on every ranking ask (F3 "Highest cost" on the
cheapest, G3 "largest first" ascending, M9 signed sort) — plus a new **payload-units**
bug (G2: UI $500 → 500 cents). Smoke-render (not built this wave) would have caught none
of the tile lies — the gap has moved from "does it render" to "is the headline true".

### Timing (submit → first rendered content; text-settle confirmed)

All 25: **p50 29.4s · p95 103.0s** · min 5.6s (M1) · max 160.4s (F5).
Frozen 15 only: p50 29.2s · p95 50.3s. Baseline was p50 18.9s / p95 ~74.5s — the candidate
config is ~10s slower at the median (rewrite+end-pass on), with a worse deep tail (F5 160s,
G5 103s).

### Pipeline diagnostics (onPipeline, per create)

- **End-pass adoption: 13/25 applied (52%).** When it applied it visibly helped labels (M14's
  badge lie became a truthful label) but it cannot fix bindings (relabel-only by design) —
  and most binding fails shipped with end-pass applied=false or with the patch dropped.
- **Structured repair: engaged 4/25** (M3, M4, M10, F2 — 1-2 rounds, all "repaired:true",
  1.8-4.4s), i.e. the compile-level repair loop fires rarely and cheaply; every repair-touched
  prompt still FAILED on semantics, so repair fixes compilation, not truth.
- Actions: M8/M11/M15 all fire approval-gated with correct payloads (M11 via typed amount;
  its "Pay full" helper is broken). M3's action is the one harmful-shaped miss (empty $0
  transfer labeled as a cancellation request).

