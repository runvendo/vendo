---
"@vendoai/core": patch
---

Three compiler correctness fixes: the inline-ref pre-pass no longer rewrites text children or quoted attribute values (only attribute expressions are scanned for inline tool calls), a stray close tag inside a `<Group>` no longer ends the group and drops the leaves after it, and `checkExpr` stops rejecting column paths that cross two array levels — `sum(orders, "lines.cents")` is what the evaluator has always computed.
