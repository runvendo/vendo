# v2 data→shape PROJECTION + value FORMATTING — browser gate

Lane branch `yousefh409/vendo-v2-correctness` (off main). Follows the
propschema gate (`docs/verification/vendo-v2-propschema` on main), which fixed
the prop-NAME class and flagged the next blocker: the model uses the correct
`options` prop but does NOT project fetched object arrays into `[{value,label}]`,
and does not FORMAT money/dates.

## What this lane added

- **`asOptions(valueField, labelField)` reshape op** (`packages/core/src/reshape.ts`)
  — maps an object array to `[{value, label}]`, strict per-row like `asPoints`.
  Runtime + compile-time shape flow + closed-vocabulary gates all updated.
- **`currencyCents` format kind** — divides integer host cents by 100 so
  `285000` formats to `$2,850.00` (was `$285,000.00` / raw cents).
- **shape-check for prewired option props** (`packages/core/src/wire-v2/shape-check.ts`)
  — a fetched object array bound straight to a `Select`'s `options` (or `Tabs`'
  `tabs`) without a `value` field now emits a per-binding `shape-mismatch`
  routing the model to `| asOptions(valueField, labelField)`. `string[]` and
  already-`{value,label}` arrays stay clean; `json` regions stay defensive.
- **Prompt guidance** (`packages/apps/src/engine.ts`, TOOL RESPONSE SHAPES area)
  — project object arrays into a component's shape; format money (cents) and
  dates in DISPLAY slots only, never into a chart/island/aggregate input.

Full gate green: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.

## Browser gate (production boot, `next build && next start`)

Driven through the real Apps create path in a real browser. demo-bank (Maple)
on :3000 as yousef@maple.com; demo-accounting (Cadence) on :3200 as Maya
Alvarez (minted HS256 `sb-cadence-auth-token`). No tuning to force a pass.

| # | host | prompt | verdict | note |
|---|------|--------|---------|------|
| 3 | demo-bank | a form to transfer money between two accounts | **PASS** | **Direct reversal of the propschema FAIL.** Both From/To account `Select`s now render real `{value,label}` options — DOM-verified: `Maple Checking`/`acc_checking`, `Maple Savings`/`acc_savings`, `Maple Credit`/`acc_credit`, `Maple Invest`/`acc_investing` (was 4 options with empty value AND empty text). Selection works. The `asOptions` projection fix delivering exactly as intended. `03-demo-bank-transfer-form.png` |
| 1 | demo-bank | spending breakdown by category this month with a chart | **PASS** (lane scope) | **Money FORMATTING now used & correct.** The breakdown `Table` renders every amount as currency via `| format(amount, currencyCents)`: housing `$2,850.00` (285000 cents), shopping `$617.49`, transport `$562.06`, subscriptions `$335.47`, dining `$236.70`, groceries `$126.61`, coffee `$30.08` — was raw cents (`AMOUNT (CENTS)` / `285000`) in the propschema run. Caveat (adjacent, host-viz): the host `MapleSpendingDonut` center total shows `$NaN` because the model ALSO fed the formatted-string binding to the donut's numeric `slices` prop (a component that sums). Three rounds of explicit display-vs-compute prompt guidance did not stop it; the clean structural fix (resolve binding shapes against host component prop schemas) is the natural next step, outside this lane's minimal scope. `01-demo-bank-spending-breakdown.png` |
| 4 | demo-accounting | overdue invoices with a reminder button | **PARTIAL / FAIL** | Real client data grounded (stat hero "8 of 12 active clients need chasing", 11-row table: Blue Bottle Coffee/Marisol Rivera, Linear/Wei Chen, Sweetgreen, Equinox, TaskRabbit, Compass, Jiffy Lube, Banfield, LegalZoom, Grant Ellison…). This generation built a **bulk "Send Reminder to All Overdue" button, NOT a per-client `Select`**, so the object→`{value,label}` Select-projection class was not exercised here (it is definitively proven on #3). Remaining FAILs are the value-formatting/nested-object class: **PROGRESS** renders raw `{"received":3,"total":6}` and **ASSIGNED TO** renders raw `{"id":"st_maya","name":"Maya Alvarez",…}` — the bounded reshape vocab has no string-join op to flatten a nested object into a readable cell (the model would need to `pick` a scalar or omit the column; guidance says so, model kept them). Dates stay raw ISO (`2026-07-21T17:00:00-07:00`), status raw enum (`missing_docs`) — the model applied no `format` reshape to any Table column despite guidance. `04-demo-accounting-overdue-invoices.png` |

## Summary

**Headline projection fix CONFIRMED working.** The object→`{value,label}` Select
projection — the exact "adjacent sibling class" the propschema gate named as the
natural next fix — now works: #3's account Selects went from blank-value/blank-text
to fully populated real labels+values. Money formatting is used and correct where
the model applies it (#1's breakdown Table shows proper currency instead of raw
cents).

**Two model-adherence gaps remain, both outside this lane's clean scope:**
- **#1 host donut `$NaN`** — the model formats the numeric `slices` prop of a
  host visualization component despite explicit display-vs-compute guidance. A
  structural guard (checking resolved binding shapes against host component prop
  schemas) is the real fix; prompt guidance alone is unreliable here.
- **#4 raw nested-object cells + unformatted dates** — the bounded reshape vocab
  cannot flatten `{received,total}` into a readable string (no join/interpolation
  op, by design), and the model did not `format(...)` date/status columns. This
  is the deferred value-formatting-in-cells + nested-object class, not the
  Select-projection class this lane fixes.
