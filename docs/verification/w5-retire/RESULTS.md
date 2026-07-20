# W5a — dialect retirement, live verification

Host: Maple (demo-bank), production boot (`next build && next start`, port 3000,
`VENDO_BASE_URL=http://localhost:3000`), live Sonnet. 2026-07-20. Three fresh
prompts (none from the frozen golden 30 or the burned DEV list). Stored
documents fetched over `/api/vendo/apps` and grepped for the retired dialect;
server log grepped for the new `[vendo] INFO` deprecated-dialect line.

| # | Prompt | Rendered | asOptions | template | currencyCents | $reshape at all |
|---|--------|----------|-----------|----------|----------------|-----------------|
| P1 | "let me choose one of my accounts and see its balance" | interactive island picker, 4 real accounts, `$9,412.20` formatted (`p1-account-picker.png`) | absent | absent | absent | absent |
| P2 | "a table of my recent transactions with merchant, amount, and date" | Kit DataTable, 20 real rows, `format:"money"` / `format:"date"` columns (`p2-transactions-table.png`) | absent | absent | absent | absent |
| P3 | "a donut chart of my balance split across accounts" | host donut bound RAW rows + Kit DataTable `format:"money"` (`p3-balance-donut.png`) | absent | absent | absent | absent |

`[vendo] INFO` deprecated-dialect lines in the server log across all creates: **0**
(the seam itself is unit-proven to fire when an op is present — engine.test.ts).

Taught-path confirmations in the stored documents: P2/P3 DataTable column
`format:"money"`/`"date"` tokens (no format pipes), P1 island uses ambient Kit
`Select` with `labelField`/`valueField`, P3 donut slices bound to RAW rows (the
never-format-chart rule held).

Honest adjacent findings (pre-existing classes, NOT this lane's scope):
- P3: `MapleSpendingDonut` (HOST component) fed raw account rows shows `$NaN`
  total — its schema expects its own item fields; binding-shape-vs-host-item
  guard only fires on reshaped bindings today.
- First P1 attempt (before `VENDO_BASE_URL` was set): island had a stray
  top-level `useState` line the compile gate doesn't catch (syntax+export only).
- Prod boot without `VENDO_BASE_URL` silently breaks tool sampling AND runtime
  reads → apps generate against a blind tool surface. The boot log does warn.
