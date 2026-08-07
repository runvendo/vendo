---
"@vendoai/core": patch
---

The `$expr` fact check and the evaluator agree about `days_until`.

`days_until(invoices.due_date)` reads the `due_date` COLUMN off every row, and the
evaluator has always refused it — "days_until() reads one date, but
invoices.due_date is a list of 3". The static check looked past the column at its
items, saw strings, and passed. So a generated app shipped through the fact check
clean and then rendered the contained data-shape notice instead of the number the
model was asked for. `days_until` is now checked as the scalar slot it is, with
the evaluator's own repair sentence. The check/evaluator agreement table that
landed with the two-level column paths grows the three rows that cover it.

Two smaller compiler corrections ride along. A duplicate attribute whose LAST value
was dropped (single-quoted, ill-formed UTF-16, an invalid action) was still reported
as "the last one wins", which sent a retry back to re-write the value that never
landed; the message now names the outcome — including the case where EVERY value
was dropped and no attribute survives at all — and two compiler-owned `id`
attributes no longer claim a winner where both are ignored. And `compilePlan`'s
issue list — which is verbatim the model's retry prompt — is capped at 64 with a
final count, the way the wire compiler already caps its own; a broken document
previously minted one sentence per stray token with no bound. That count reads
"1 further problem was not listed" when exactly one is omitted.

Internal only, no public surface change: the wire attribute layer's dead `patch`
element mode, its action-attribute regex duplicated into the printer, and
`state.ts`'s pass-through re-export of `isWellFormedUtf16` are gone.
