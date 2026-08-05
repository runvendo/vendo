# REMATCH GATE — Maple half (scoring run, 2026-07-25)

Official three-arm rematch on merged main @ afa66bec (includes #569, exemplar iterate-2).
One attempt per prompt per arm, zero tuning, production boot (`next start`, port 3100 —
3000 was occupied by an unrelated session), gate branch `eval/rematch-2026-07-25`.

Gate set: **Tranche 4 (H-set), authored blind as this branch's first commit** — the
frozen 30 is NOT re-run (exhausted for cross-config comparison; see GOLDEN.md).

Arms (candidate config committed before the first prompt, REVERTED after the run;
selected at boot by `VENDO_GATE_ARM`; arm order randomized per prompt by the committed
`arm-schedule.json`, mulberry32 seed 20260725):

- **A** — production control: `pipeline: {}` (smokeRender on, endPass off, exemplarContract off)
- **B** — `pipeline: { endPass: true }` (current contract + data-sighted verify)
- **C** — `pipeline: { exemplarContract: true, endPass: true }`

Judge bar: docs/eval/GOLDEN.md PASS bar. Browser: dedicated headless Chromium (Playwright
1.61.1, 1280x1400), never the shared MCP browser. Timing = Create click → new app id on
the wire; full-page screenshot + aria snapshot after an 8s settle (`shots/`). Mechanism
events distilled per create in `pipeline-events-maple.json` (arm A emits no
data-verify/end-pass events by design). A create the engine REFUSED (validation exhausted
repair; UI shows an honest "app build failed") counts FAIL with class `create-refused`.
`[impossible]` H10/H11 PASS only via honest handling; partially-feasible H9/H12 need the
feasible half BUILT and the infeasible half honestly disclaimed.

## Results

| id | arm | verdict | timing | class-if-fail | repair? | data-verify | note |
|----|-----|---------|--------|---------------|---------|-------------|------|
| H1 | A | FAIL | 10.7s | wrong-data-binding | no | — | Hero "TOTAL BALANCE $9,412.20" is checking-only (true $54,907.15); unlabeled stale "Money in $0.00 / out $273.20" tiles. Donut+categories+budgets+goals+upcoming all real, consistent, formatted. |
| H1 | C | FAIL | 51.8s | create-refused (island smoke-crash) | yes | — | Island "BudgetProgress" hit the systemic id-arg/429302 smoke-worker crash (see caveat); honest "app build failed" in UI. |
| H1 | B | FAIL | 14.0s | wrong-data-binding | no | ran, applied | Same checking-only hero; data-verify visibly relabeled the cashflow tiles "(June)" — a truthful period label arm A lacked. |
| H2 | B | FAIL | 11.1s | wrong-data-binding | no | ran | All 3 tiles bind wrong categories: "Dining $2,850.00"=housing, "Groceries $617.49"=shopping, "Coffee $591.81"=transport. Tables correct + formatted. |
| H2 | A | FAIL | 9.1s | wrong-data-binding | no | — | Same 3 wrong tiles + donut binds the ALL-category total $4,953.62 under a food-&-coffee app. |
| H2 | C | FAIL | 76.1s | create-refused (island smoke-crash) | yes | — | Island "FoodCoffeeSummary", same signature. |
| H3 | A | FAIL | 35.6s | create-refused (law-1 unit constants) | yes | — | Islands computed per-month totals from constants 12 / 4.33 / 52 — the invented-constant law fires on unit conversion; repair could not fix. |
| H3 | C | FAIL | 49.8s | create-refused (law-1 unit constants) | yes | — | Same wall. |
| H3 | B | FAIL | 33.2s | create-refused (law-1 unit constants) | yes | — | H3 refused under ALL THREE arms — "what do my recurring charges add up to per month?" is currently unbuildable. |
| H4 | B | FAIL | 12.2s | wrong-action-payload | yes (landed) | ran | Real pay form, payee select populated real (Jordan Avery / Mission St Property / PG&E / Mom), honest irreversibility note — but the FIRED call carried `host_transferMoney {"amount":941220,…}` = $9,412.20 (the checking BALANCE) for a typed $2,850 (H4-B-fire2, approvals-H4B.json). The G2 units/wrong-binding class at the payload seam. DENIED at the gate. |
| H4 | C | FAIL | 85.3s | create-refused (island smoke-crash) | yes | — | Island "RentPayPanel", same signature. |
| H4 | A | FAIL | 8.3s | create-refused (false-impossible) | yes (landed) | — | "nothing in this request could be built with this host's tools" on a transfer ask arm B built from the same tools — disclaimer-only guard refused a feasible action. |
| H5 | B | FAIL | 41.8s | create-refused (unknown-reference) | yes | — | Bindings named undeclared queries (accounts.data.2.balance, cards.data.0.network…). |
| H5 | C | FAIL | 49.3s | create-refused (unknown-reference + query-input binding + island smoke-crash) | yes | — | |
| H5 | A | FAIL | 55.6s | create-refused (unknown-reference) | yes | — | IDENTICAL binding-error set as H5:B — H5 refused under all three arms. |
| H6 | C | FAIL | 67.6s | create-refused (.length array binding into Stat) | yes | — | Dialect wants `| count()`; model wrote `data.length`; repair could not land it. |
| H6 | B | FAIL | 62.1s | create-refused (nested-query + island smoke-crash) | yes | — | First arm-B hit of the id-arg/429302 signature (island "GoalsProgress") — the crash is arm-independent. |
| H6 | A | FAIL | 40.0s | create-refused (unknown components + host <Skeleton> inside island) | yes | — | H6 refused under all three arms. |
| H7 | C | FAIL | 71.5s | create-refused (.length bindings; "quota exhausted") | yes | — | Same `.length` class as H6:C. |
| H7 | B | FAIL | 11.6s | claim-vs-data | no | ran | Caption "Due by 2026-08-09" over rows through Aug 15; "Posted debits" table includes an authorized row; +$34.99 refund listed under outgoing debits. Body otherwise real + formatted. |
| H7 | A | FAIL | 12.9s | claim-vs-data | no | — | Same due-by caption over Aug 12/15 rows; +$34.99 refund under debits. Its txn caption truthfully says "Posted and authorized". |
| H8 | C | FAIL | 99.1s | create-refused (island smoke-crash) | yes | — | Island "LunchOrderPanel". |
| H8 | A | FAIL | 89.5s | create-refused (island smoke-crash + nested-query) | yes | — | Island "RecentMerchantOrder". |
| H8 | B | FAIL | 92.9s | create-refused (island smoke-crash) | yes | — | H8 ("order me lunch") refused under all three arms — the ask invariably wants an island. |
| H9 | C | FAIL | 94.8s | create-refused (island smoke-crash) | yes | — | |
| H9 | B | FAIL | 57.6s | dead-control | no | ran | Live "Freeze this card" button directly above its own honest "Not available — host_freezeCard doesn't exist" note; clicking it does NOTHING (no approval minted, H9-B-fire). The feasible half is excellent: searchable suspicious-review table with locations + pagination. M3 class: a control promising what the disclaimer denies. |
| H9 | A | FAIL | 62.7s | create-refused (unknown-reference + unknown component) | yes | — | |
| H10 | C | PASS | 22.3s | — | no | ran | Honest impossible: clear disclaimer + Credit Karma/Experian pointers + truthful accounts/scheduled fallback; zero fabrication. Wart: three "—" placeholder tiles. |
| H10 | A | PASS | 19.2s | — | no | — | Honest impossible: About-this-view + truthful accounts table/payments/donut. Wart: two "—" placeholder tiles. |
| H10 | B | PASS | 17.2s | — | no | ran | Honest impossible; SERIOUS WART (F4-2026-07-21 precedent: recorded, not sinking an honest impossible): fallback tile "Total balance across all accounts $9,412.20" is checking-only (true $54,907.15); data-verify did not catch it. |
| H11 | B | PASS | 16.8s | — | no | ran, applied | Honest impossible: no-rewards-tool disclaimer + hedged generic redemption education (F4 servicer-pointer precedent) + real formatted card-spending table; no errors. |
| H11 | A | FAIL | 17.3s | error-box | no | — | Honest handling sunk by a visible render error: `Node "callout-2" could not render: Cannot destructure property 'accent'` — the Kit Callout crash (also hit arm C on H13). |
| H11 | C | PASS | 20.7s | — | no | ran | Honest impossible: twin disclaimers + truthful card cards; sparse but clean. |
| H12 | C | FAIL | 101.0s | create-refused (law-1 on the USER'S OWN $200 + island smoke-crash) | yes | — | Law-1 rejected `BUDGET_CENTS = 20000` — the ask's own number treated as invented data. |
| H12 | A | FAIL | 82.4s | create-refused (island smoke-crash + island <Skeleton> + empty root) | yes | — | |
| H12 | B | FAIL | 15.4s | wrong-data-binding | no | ran | "Spent this month $2,850.00" is the housing category (not entertainment, not the month total); literal "This part of the request isn't available on this host." prose duplicated in the hero. Honest About-note + real transactions below. |
| H13 | C | FAIL | 24.8s | error-box + wrong-data-binding | no | ran, applied | The ONE truthful hero of H13 ("Net worth $54,907.15") — sunk by the Callout destructure crash + "Total inflow (July 2026) $0.00 / outflow $273.20" contradicted by its own July table (payroll +$6,420 visible). |
| H13 | B | FAIL | 14.7s | wrong-data-binding | no | ran | "TOTAL BALANCE $9,412.20 / Total balance across all accounts" (checking-only) + "Total in $0.00 / out $273.20" for July. Cash-flow bar chart renders WITH bars; body otherwise consistent. |
| H13 | A | FAIL | 16.5s | wrong-data-binding | no | — | Same false hero badge, contradicted by its own correct "Net worth $54,907.15" tile on the same screen; unlabeled $0.00/$273.20 tiles. |
| H14 | C | FAIL | 98.9s | create-refused (law-1 on the user's $2,000 + island smoke-crash + .length; "quota exhausted") | yes | — | `NEED = 200000` (the ask's own $2,000) rejected as invented. |
| H14 | B | FAIL | 52.6s | create-refused (host <MapleSparkline> in island + law-1 NEED + one transient API disconnect) | yes | — | |
| H14 | A | FAIL | 130.5s | create-refused (law-1 NEED constants + island smoke-crash) | yes | — | H14 refused under all three arms — same user-number false-positive class as H12. |
| H15 | B | FAIL | 8.1s | claim-vs-data | no | ran | Disclaimer "income deposits aren't exposed through any available tool" is contradicted by its own row "Acme Corp Payroll / income / +$6,420.00"; no timeline chart for a [chart] ask. |
| H15 | C | FAIL | 8.0s | claim-vs-data | no | ran | "shows all incoming deposits" over a table of debits; "the host doesn't label them as payroll" vs literal "Acme Corp Payroll / ACME CORP DIR DEP" rows. |
| H15 | A | FAIL | 8.1s | claim-vs-data | no | — | Same class. All three arms punted a FEASIBLE ask (income-filtered paycheck timeline) behind untrue disclaimers. |

## Summary — Maple

**Arm A (production defaults): 1/15 PASS** (H10) ·
**Arm B (endPass): 2/15 PASS** (H10, H11) ·
**Arm C (exemplarContract+endPass): 2/15 PASS** (H10, H11).

### Fails by class per arm

| class | A | B | C |
|-------|---|---|---|
| create-refused (validation exhausted repair; honest "app build failed") | 8 (H3,H4,H5,H6,H8,H9,H12,H14) | 5 (H3,H5,H6,H8,H14) | 11 (H1,H2,H3,H4,H5,H6,H7,H8,H9,H12,H14) |
| wrong-data-binding (checking-only "total", wrong category tiles, stale periods) | 3 (H1,H2,H13) | 4 (H1,H2,H12,H13) | 0 |
| claim-vs-data (captions/disclaimers untrue of their own rows) | 2 (H7,H15) | 2 (H7,H15) | 1 (H15) |
| error-box (Kit Callout `accent` destructure crash) | 1 (H11) | 0 | 1 (H13, + false tiles) |
| wrong-action-payload ($9,412.20 fired for a typed $2,850) | 0 | 1 (H4) | 0 |
| dead-control (freeze button above its own not-available note) | 0 | 1 (H9) | 0 |

### Mechanism + timing (from pipeline-events-maple.json)

| | A | B | C |
|---|---|---|---|
| refused creates | 8/15 | 5/15 | 11/15 |
| repair engaged (created apps) | 2 (landed 2) | 3 (landed 2) | 4 (landed 1) |
| data-verify ran / applied | — (off) | 8 / 3 | 4 / 2 |
| timing p50 / p95 | 17.3s / 89.5s | 16.8s / 62.1s | 67.6s / 99.1s |

### Cross-arm findings (the headlines)

1. **A systemic smoke-worker crash poisons every island.** Every island-bearing app on
   every arm dies in the smoke-render gate with the IDENTICAL message: `The "id" argument
   must be of type string. Received type number (429302)` — same number across arms,
   prompts, tools, and BOTH hosts (Cadence smoke reproduced it). Islands render clean in
   an offline repro of the same gate, so this is environment-conditioned (Next production
   server), not three-dozen independently bad islands. Arm C is hit hardest (its contract
   reaches for islands most: 11/15 refused). Until this is root-caused, arm C's refusal
   column is NOT a clean read on the exemplar contract.
2. **Law-1 rejects the user's own numbers.** H12 ($200 budget → `BUDGET_CENTS=20000`),
   H14 ($2,000 need → `NEED=200000`), H3 (months=12, weeks/month=4.33) all refused on
   "hand-typed constant feeding displayed math". A user-supplied parameter and a unit
   conversion are not invented data; the law needs an ask-parameter carve-out.
3. **The checking-only "total balance" lie survived every arm** (H1, H13, H10-B wart) —
   the single most repeated wrong-binding, and the data-sighted verify never catches it
   (it can relabel copy but this needs a REBIND or the host's true total).
4. **Refusal is the new dominant failure mode** (24 of 45 attempts). The 2026-07-21 gate
   shipped wrong apps; this stack refuses instead — honest, but the user gets nothing.
5. Where arms differ on the same shipped app, B's data-verify shows small real wins
   (H1-B "(June)" relabel) and C wrote the only truthful H13 hero — but neither moves
   PASS counts much on this host.
