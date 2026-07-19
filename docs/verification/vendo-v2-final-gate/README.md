# FINAL 6-case gate — merged main (#385+#386+#387+#388)

Same 6-prompt matrix as docs/verification/vendo-v2-propschema, driven through the
real Apps create path in a real browser, production boot (`next build && next start`,
`NODE_OPTIONS=--max-old-space-size=3072`). Arc: 2/6 (generalize) → 2/6 (propschema) → this run.
No tuning between prompts; fails reported as fails.

| # | host | prompt | verdict | timing | note |
|---|------|--------|---------|--------|------|
| 1 | demo-bank | spending breakdown by category this month with a chart | PASS | complete ≤16s observed (submit→full app; "Creating…" still shown at ~5s; no partial paint observed in surface) | Real composed app: **host donut chart** (`MapleSpendingDonut`, `source:host`, slices via `$path:/spending/data`) renders real category segments + prewired Table (`rows` + `$path`) populated with 7 real category rows. **FORMATTING CLASS FIXED in the tree: all table amounts are real dollars — housing $2,850.00, shopping $617.49, transport $562.06, subscriptions $335.47, dining $236.70, groceries $126.61, coffee $30.08** (prior run: raw cents 285000/61749/…, "AMOUNT (CENTS)"). Column headers correct. Caveat: the donut's center TOTAL shows **$475,841.00** — the host component sums the cents-denominated slices and renders as dollars (true total $4,758.41); units seam inside the HOST component's own total, not the generated tree (table ✓). No error box, no raw braces. `01-demo-bank-spending-breakdown.png`, `01b-demo-bank-spending-breakdown-table.png` |
| 2 | demo-bank | a filterable list of recent transactions | PASS | **complete 8.3s** (submit→full app, in-page timer) | All-prewired branded composition: Account/Category/Status Selects + Table with 25 real rows. **BOTH new #387 vocabs live in the tree**: Account Select options via `$reshape:[{op:"asOptions",args:["id","name"]}]` over fetched `/accounts/data` — **DOM-verified real projected options** (Maple Checking/acc_checking, Maple Savings, Maple Credit, Maple Invest) — the prior run's blank-Select projection class is FIXED; Table rows via `$reshape` `format amount currencyCents` + `format timestamp date` — **amounts render -$87.00/-$418.00 and dates "Jul 19, 2026"** (prior run: raw cents + raw ISO). Correct headers, rowKey, honest emptyLabel. Caveat: filter Selects are display-only — no state binding wires them to the Table (form_input change → rows stay 25); client-state filter wiring remains an unbuilt dialect feature, flagged as remaining gap (not part of the PASS bar, same as both prior runs). `02-demo-bank-filterable-transactions.png` |
| 3 | demo-bank | a form to transfer money between two accounts | PASS | **complete 6.3s** | **Direct reversal of the failure that held BOTH prior runs to FAIL.** All-prewired form (From/To Selects, Amount, Note, Transfer Funds). (1) PROJECTION CLASS FIXED: both account Selects use `options:{$path:"/accounts/data",$reshape:[{op:"asOptions",args:["id","name"]}]}` and render **real options DOM-verified** (Maple Checking/acc_checking, Maple Savings, Maple Credit, Maple Invest) — prior two runs: 4 options with empty value AND empty text. (2) ACTION-PAYLOAD CLASS FIXED: Transfer Funds carries `onClick:{action:"host_transferMoney",payload:{fromAccount,toAccount,amount,note}}` bound to named fields; **live click test (Checking→Savings, $25, note) FIRED the action → "Action is waiting for approval (apr_a2f5809e-…)"** — real write path, approval-gated as designed. Left pending (approval is the host's human gate). Core interaction delivered end-to-end. `03-demo-bank-transfer-form.png`, `03b-demo-bank-transfer-fired-approval.png` |
| 4 | demo-accounting | overdue invoices with a reminder button | FAIL | complete ≤7.6s (app visible by +7.6s; this surface shows no "Creating" indicator so paint not separable) | Split verdict. THE GOOD (both target classes work): honest grounding to real deadline data (Cadence has no invoice tools — model used `/deadlines/data` + `/dashboard/data`, 12 real client rows, stat cards 8 missing-docs / 21 outstanding / nearest = Blue Bottle Coffee); reminder button carries a REAL action `onClick:{action:"host_sendClientMessage",payload:{message:<real reminder text>,clientId:{$path:"/dashboard/data/nearestDeadlineClient/id"}}}` — **live click FIRED → "Action is waiting for approval (apr_7c5572ba-…)"**; prior run's reminder path was a blank client Select, now functional. THE FAIL (PASS-bar violations): table-1 has NO `$reshape` format ops → **PROGRESS renders raw braces `{"received":3,"total":6}` and ASSIGNED TO renders raw JSON `{"id":"st_maya","name":"Maya Alvarez","role":"Account Manager","initials":"MA"}` in every row**, and ALL dates in both tables render raw ISO (`2026-07-21T17:00:00-07:00`, incl. the hero Filing Deadline stat). "No raw-braces" + "dates formatted" are explicit bar items → FAIL. Formatting vocab exists (#387, used in #2) but the model applied it inconsistently, and object-valued columns have no object→string projection. `04-demo-accounting-overdue-invoices.png`, `04b-demo-accounting-reminder-fired-approval.png` |
| 5 | demo-accounting | a revenue vs expenses summary with a chart | FAIL | complete 35.6s (longest of the run; likely repair-loop rounds) | Split verdict, big directional wins. THE GOOD: **the generated island chart RENDERS** — `revenueexpenseschart-1` (`source:generated`) draws a real two-series Jan–Jun line/area chart (Received vs Outstanding, y 0–38, real points) with **no jail error box** (#388's island-import gate holding; prior runs: error-box, then empty chart body). And the prior run's **fabrication is gone**: instead of nonsense "$60 revenue", the app honestly reframes — subtitle "Document collection progress this season" — and every stat is real host data via island props (docsTotal 59, docsReceived 38, docsOutstanding 21, 64% rate, 12 clients, 8 missing docs; matches `/deadlines`+`/dashboard`). THE FAIL: (1) same PASS-bar violation as #4 — the Client Progress table renders **raw braces `{"received":3,"total":6}`** per row + **raw ISO deadlines**; (2) caveat: the Jan–Jun monthly shape is island-interpolated from real totals, not real monthly host data (no monthly tool exists) — anchored-real but synthesized trend. Raw-braces rule → FAIL. `05-demo-accounting-revenue-vs-expenses.png`, `05b-demo-accounting-revexp-progress-table.png` |
| 6 | demo-accounting | a new-client intake form | PASS | complete 30.4s | **The prior run's facade is resolved exactly as #388 designed.** Fully all-prewired (tree `sources:["prewired"]` only), 4 clean sections (Business Info, Contact/Address, Engagement Details, Document Checklist Preview), well-labeled fields incl. native date picker. All 3 Selects render real `{value,label}` options DOM-verified (Entity Type: Sole Proprietorship/LLC/S-Corp/C-Corp/Partnership/Non-Profit; Services: Tax Prep/Bookkeeping/Payroll/Advisory/Audit Support/Full-Service; Referral: Client Referral/Google Search/LinkedIn/Website/Other). **ZERO Buttons in the tree — no fake Submit — and in its place the ACTION-HONESTY GUARD renders an explicit disclaimer: "No host tool is available to save a new client from this form. Contact your administrator to enable client creation."** — precisely the PASS bar's "honest disclaimer when the host lacks the tool" branch (Cadence has no client-creation tool). Zero raw braces (DOM-verified), no error box. `06-demo-accounting-client-intake-form.png`, `06b-demo-accounting-intake-honesty-disclaimer.png` |

## Summary — 4/6 PASS (#1, #2, #3, #6), 2/6 FAIL (#4, #5)

**The arc: 2/6 (generalize, main) → 2/6 (propschema, #385) → 4/6 (this run, merged #385+#386+#387+#388).**
First run where a majority passes, and both fails are now a SINGLE class.

### Per-class status
- **Prewired prop names (Table `rows`, Select `options`, Button `onClick`) — RESOLVED, held.** Zero
  invented-prop symptoms anywhere in the matrix (the #385 fix, re-confirmed on merged main).
- **Data→shape projection (`asOptions`) — RESOLVED (#387).** The class that blocked #3 in both prior
  runs is gone: every dynamic Select in the run renders real projected `{value,label}` options
  (#2 accounts, #3 both account pickers). DOM-verified, zero blank options in 6/6 apps.
- **Action payloads — RESOLVED (#388 + #385).** #3 Transfer Funds carries
  `host_transferMoney` + full field payload and FIRES (approval-gated, apr id on screen); #4 reminder
  button carries `host_sendClientMessage` with `$path`-bound clientId and FIRES (approval-gated).
- **Action honesty — RESOLVED (#388).** #6 renders an explicit "No host tool is available…"
  disclaimer instead of the prior facade Submit; zero dead buttons in the tree.
- **Island charts — RESOLVED as a jail/render class (#388).** #5's generated island renders a real
  two-series chart, no jail error box, real host data via island props. (Prior: error box → empty body.)
- **Honest grounding — improved.** #5's prior fabricated "$60 revenue" replaced by real document-collection
  data with an honest reframe subtitle; #4 grounded to real deadlines data.
- **Value formatting — PARTIAL (the remaining failure class, both fails).** `format currencyCents/date`
  ops work and the model uses them on Maple (#1 table, #2 amounts + dates all formatted — prior run's raw
  cents/ISO fixed). But on Cadence it applied NO format ops: #4/#5 tables show raw ISO deadlines and—worse—
  **object-valued columns render raw JSON braces** (`{"received":3,"total":6}`, `{"id":"st_maya",…}`), an
  explicit bar violation. Object→string projection for object-valued columns doesn't exist in the reshape
  vocab; consistent format-op application isn't enforced. This single class is now the whole gap to 6/6.

### Timing (submit → complete app in surface; browser-observed)
| # | host | complete |
|---|------|----------|
| 1 | demo-bank | ≤16s (bounded by poll; "Creating…" at ~5s) |
| 2 | demo-bank | 8.3s |
| 3 | demo-bank | 6.3s |
| 4 | demo-accounting | ≤7.6s |
| 5 | demo-accounting | 35.6s (longest; likely repair rounds) |
| 6 | demo-accounting | 30.4s |
No separable first-paint was observable in either surface (app appears atomically when create returns);
the #386 engine-side instrumentation (paint ~1.4s / complete ~9.9s) is not yet surfaced in the UI.
Maple runs sit at ~6–16s; Cadence's two 30s+ runs suggest repair-loop rounds — both above the <1s paint /
<10s complete v2 bar; sequential paint→full + owned serving remain the known speed follow-ups.

### Remaining known gaps
1. **Object-valued column rendering + inconsistent format ops (#4, #5)** — the one class holding the
   score; natural next fix (object→string projection op + format-op nudge/enforcement).
2. Host-component units seam: #1 donut center total treats cents-sum as dollars ($475,841.00 vs true
   $4,758.41) inside `MapleSpendingDonut` — host wiring, not the generated tree (its table is correct).
3. Client-state filter wiring: #2's filter Selects are display-only (no dialect feature yet; not in bar).
4. #5's monthly series is island-interpolated from real totals (no monthly host tool exists).
5. Speed to bar: complete ≤10s holds on Maple simple prompts only; repair rounds blow it out.
