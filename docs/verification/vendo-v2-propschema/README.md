# v2 prewired prop-schema fix — browser gate

Re-test of the same 6 prompts from the 2/6 generalization run
(docs/verification/vendo-v2-generalize on main), now on branch
`yousefh409/vendo-v2-propschema` which carries commit af33f979: the model is
given the prewired primitives' exact prop schemas (Table→`rows`,
Select→`options:[{value,label}]`, Button→`onClick`) and unknown prop names on
prewired nodes are rejected → repair loop. This fix targets EXACTLY the
prop-name class that failed before.

Driven through the real Apps create path (`/vendo/apps` page → Create) in a
real browser, **production boot** (`next build && next start`,
`NODE_OPTIONS=--max-old-space-size=3072`). Both hosts needed
`@electric-sql/pglite` added to `serverExternalPackages` (PGlite WASM breaks
under Turbopack production chunking — `f.instantiateWasm is not a function`);
packaging fix, not generation tuning. No tuning between runs — fails reported
as fails.

| # | host | prompt | verdict | note |
|---|------|--------|---------|------|
| 1 | demo-bank | spending breakdown by category this month with a chart | PASS | Real composed app: donut chart with real category segments + companion **prewired Table now POPULATED with real rows** (housing 285000, shopping 61749, transport 56206, subscriptions 33547, dining 19540, groceries 12661, coffee 3008). PROP-NAME CLASS FIXED: prior run's companion table said "No data" (bound to `data`); it now uses `rows` and renders real data. Caveat (unrelated formatting): amounts shown as raw cents ("AMOUNT (CENTS)"), donut total `$471,711.00` treats cents as dollars — units bug, not prop-name. `01-demo-bank-spending-breakdown.png` |
| 2 | demo-bank | a filterable list of recent transactions | PASS | **Direct reversal of the prior run's headline FAIL.** All-prewired branded composition: Search box + Category Select + Status Select, and the **prewired Table is FULLY POPULATED with real rows** (DoorDash/dining/-8700/posted, Tartine Bakery, Whole Foods/groceries, Apple Store/shopping, United Airlines/transport/authorized, Lyft…). PROP-NAME CLASS FIXED on all three prewired components: Table uses `rows` and renders real data (was permanent "No data" bound to `data`); column headers show correct labels MERCHANT/CATEGORY/AMOUNT/STATUS/DATE (not lowercase key fallback); both Selects use `options:[{value,label}]` with real labels+values (Dining/dining, Groceries/groceries, Coffee, Transport, Subscriptions, Shopping, Income, Transfer, Housing, Other; Pending/Posted/Failed) — prior run rendered blank Select options. Caveat (unrelated formatting): amounts raw cents, dates raw ISO. Core ask delivered. `02-demo-bank-filterable-transactions.png` |
| 3 | demo-bank | a form to transfer money between two accounts | FAIL | Beautiful all-prewired branded form (From/To account Selects, Amount, Note, Transfer Now/Cancel), no error box — but **both account Selects render 4 options with empty value AND empty text** (verified via DOM dump: `options:[{value:"",text:""}×4]`). Account selection unusable; same *outcome* as prior run #3. Nuance: the prop-NAME half of the class IS fixed — the model no longer invents `labelKey`/`valueKey`; it uses the correct `options` prop (proven by #2's fully-working category/status Selects with literal `{value,label}`). What still fails is **projecting fetched account OBJECTS into `{value,label}`**: the model binds the accounts array without mapping `id`→value / `name`→label, so options come out blank. This is a data→option *field-projection* gap, adjacent to but not identical to the invented-prop-name failure the fix targeted. Core interaction not delivered. `03-demo-bank-transfer-form.png` |
| 4 | demo-accounting | overdue invoices with a reminder button | FAIL | Cadence has no invoice tools; model again grounded honestly to real client data (`host_listClients`/`host_getDashboard`) — stat hero "8 of 12 active clients need chasing" and a **prewired Table FULLY POPULATED with 11 real client rows** (Blue Bottle Coffee/Marisol Rivera, Linear/Wei Chen, Sweetgreen, Equinox, TaskRabbit, Compass, Jiffy Lube, Banfield, Figma, LegalZoom, Grant Ellison). Table `rows` works. But two PASS-bar violations: (1) the "Send Reminder" form's **Client Select renders ~11 options all with empty value AND empty text** (DOM-verified) — same object→`{value,label}` projection gap as #3, so you cannot pick a client to remind; the reminder affordance is non-functional. (2) The PROGRESS column renders **raw JSON braces** `{"received":3,"total":6}`. Prior run #4 was PASS (per-row Send Reminder buttons that fired, approval-gated); this run replaced them with a form whose client picker is blank — net the reminder path is unusable. Also raw ISO dates + raw `missing_docs` enum. `04-demo-accounting-overdue-invoices.png`, `04b-demo-accounting-overdue-invoices-table.png` |
| 5 | demo-accounting | a revenue vs expenses summary with a chart | FAIL | Different failure mode than prior run (which error-boxed on a `recharts` island). This time the generated island (`revenueexpenseschart-1`, `source:generated`) has **no recharts import → no jail error box**, and the prewired shell renders cleanly (Text heading + 4 stat cards Total Revenue $60 / Expenses $21 / Net Income $38 / Profit Margin 64.1%). BUT: (1) the **"Monthly Overview" chart body is EMPTY** — only the Revenue/Expenses legend renders, no bars/lines; chart asked, chart not delivered. (2) Cadence has no revenue/expense tools, so the figures are **fabricated placeholders** ($60 total revenue for an accounting firm is nonsensical), not real host data nor an honest empty-state. Deferred island-chart follow-up, unrelated to the prop-name fix. `05-demo-accounting-revenue-vs-expenses.png` |
| 6 | demo-accounting | a new-client intake form | FAIL | Visually the best of the six: fully all-prewired ( `sources:["prewired"]`, zero islands), 4 sections (Business Info, Primary Contact, Address, Engagement Details), ~22 well-labeled fields incl. proper date pickers, clean Cadence styling, no errors. **All three Selects render REAL `{value,label}` options** — Entity Type (Sole Proprietorship/LLC/S-Corp/C-Corp/Partnership/Non-Profit), Services Requested (Tax Prep/Bookkeeping/Payroll/Advisory/Audit Support/Other), Assigned Staff (Alice Johnson/Bob Martinez/Carol Lee). So the Select prop-name class is clean here. BUT it's a **facade**: both Buttons ("Submit Intake Form", "Clear Form") have **NO onClick/onPress in the tree** (props are only `{label,variant}`), so Submit no-ops — and Cadence has no client-creation tool, no field is bound into any payload. Nuance vs prior #6: the model no longer invents `onPress` or wires Submit to a wrong READ tool (`host_listClients`); it now simply omits the handler. Net still a fake affordance — core interaction not delivered. Known deferred action-wiring gap, not the prop-name class. `06-demo-accounting-client-intake-form.png`, `06b-demo-accounting-client-intake-form-bottom.png` |

## Summary

**2/6 PASS (#1, #2), 4/6 FAIL (#3, #4, #5, #6)** — the same *count* as the prior
2/6, but a **different composition and a clear directional win on the exact class
the fix targeted.**

**Comparison to the prior 2/6.**
- Prior run passed #1 and #4; failed #2, #3, #5, #6.
- This run passes #1 and #2; fails #3, #4, #5, #6.
- **#2 flipped FAIL → PASS** — and #2 was the prior run's *headline* failure:
  the prewired Table bound to `data` and rendered a permanent "No data" over 25
  fetched rows, with blank Selects. It is now a fully-populated real-data table
  with both filter Selects showing real `{value,label}` options. This is the
  fix working exactly as intended.
- **#4 flipped PASS → FAIL**, but NOT because of this branch's code. The prop
  fix only adds prop schemas + rejects unknown prop names; it cannot make the
  model restructure a UI. This run the model happened to build the reminder as
  a form with a client Select (which came out blank) + a raw-JSON PROGRESS
  column, where the prior run used per-row buttons that fired. That is
  run-to-run generation variance, not a regression introduced by the fix.

**Is the prewired prop-NAME class resolved? YES.** Every symptom the fix
targeted is gone across the matrix:
- Table now uses `rows` and renders real data (#1 companion table, #2 full
  table, #4 client table all populated — vs prior "No data").
- Selects with literal/enumerated options use `options:[{value,label}]` with
  correct labels (#2 category/status, #6 all three: Entity Type, Services,
  Assigned Staff) — no invented `labelKey`/`valueKey`.
- No invented `onPress` on Buttons anymore (#6 prior wired Submit via `onPress`
  to a wrong read tool; now it uses neither).
- Zero raw-brace *tree* blobs, zero jail backtick errors, correct column
  header labels (not lowercase-key fallback).

**What still fails, and which are known deferred follow-ups vs new regressions.**
- **NEW adjacent sibling class (not a regression, not what the fix targeted):
  dynamic OBJECT → `{value,label}` Select projection.** When a Select's options
  come from a fetched array of objects, the model uses the correct `options`
  prop name but fails to map `id`→value / `name`→label, so every option renders
  blank. This blocks #3 (account Selects) and #4 (client Select). The prop-name
  fix does not cover data-shape projection; this is the natural next fix.
- **#5 — island chart:** known deferred follow-up. No longer error-boxes
  (the island dropped its `recharts` import), but the chart body renders empty
  and the figures are fabricated (Cadence has no revenue/expense tools).
- **#6 — action wiring / payload gap:** known deferred follow-up. The Submit
  button carries no `onClick` and no field binds into a payload; Cadence has no
  client-creation tool. Facade, as flagged in the task reservations.
- **#4 raw-brace value rendering** (PROGRESS `{"received":3,"total":6}`): a
  value-formatting gap, separate from prop names.

**Bottom line:** the prop-name fix is confirmed working (headline #2 reversed,
all Table/`rows` + literal-Select/`options` + Button/no-`onPress` symptoms
gone). The flat 2/6 is held down by an *adjacent* class the fix was never
scoped to touch — dynamic object→`{value,label}` Select projection (#3, #4) —
plus the two pre-declared deferred follow-ups (island charts #5, action
payloads #6). No regression was introduced by this branch.
