---
"@vendoai/core": patch
---

Three compiler correctness fixes: the inline-ref pre-pass no longer rewrites text children or quoted attribute values (only attribute expressions are scanned for inline tool calls), a stray close tag inside a `<Group>` no longer ends the group and drops the leaves after it, and `checkExpr` now resolves a column exactly as the evaluator does — one array level per hop, so `sum(orders, "lines.cents")` passes the check as it has always evaluated, while a list the field's own type declares, and any list in `difference()`'s two scalar slots, are rejected by both halves.
