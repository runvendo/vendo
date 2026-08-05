---
"@vendoai/core": major
"@vendoai/apps": minor
---

The wire dialect becomes a strict TSX subset, with one call grammar.

`compileWire` and `printWire` change surface syntax. A document already stored as
a canonical tree is unaffected — the IR is untouched, `$reshape` still carries the
same steps — but wire TEXT written against the old grammar no longer compiles,
which is why this is a major bump.

- **Reshapes are value-first nested calls.** `{revenue.rows | asPoints(month,
  revenue)}` becomes `{asPoints(revenue.rows, "month", "revenue")}`, and a chain
  nests instead of piping: `rename(pick(q.rows, "month"), "month", "label")`.
  Reading the nesting from the inside out reads the steps in order. Field
  arguments are quoted strings; bare identifiers in argument position are gone.
  The printer emits chains inside-out under the unchanged byte-identical
  round-trip law, and it refuses to print a step no longer writable on the wire,
  falling back to the quoted object literal.
- **Every aggregate names its field.** `sum(invoices.amount_cents)` becomes
  `sum(invoices.data, "amount_cents")`; `count(rows)` is unchanged. The implicit
  column read is gone from the call surface — an aggregate reads
  `rows.field` explicitly.
- **`group_by` takes the rows it groups, plus a descriptor.**
  `group_by(rows, "issued_at", "month", sum.of("amount_cents"))` — arity 3 to 4.
  Because the rows are an argument, the old "aggregates the SAME rows it groups"
  inference retires with the grammar that needed it, and `count.of()` replaces
  `count(rows)` in the aggregate slot.
- **Comments are JSX comments.** `{/* … */}` replaces `<!-- … -->`; the HTML form
  is no longer a comment.
- **Braces in text are refused**, as the new `braces-in-text` issue code.
  `<Text>Total: {q.total}</Text>` rendered the braces literally; a value reaches
  the screen through a binding (`<Text text={q.total}/>`).

**Two aggregate vocabularies collapse into one, and `avg` retires.** The dialect
had a reshape `avg` and an expression `average` on the same surface, where the
wrong one silently dropped the attribute. The surviving names are `sum, count,
average, min, max, difference, days_until, group_by`. `avg` is removed from
`RESHAPE_OPS`; `sum`/`min`/`max`/`count` stay in the registry for STORED
documents but are no longer writable on the wire, so exactly one `sum` is
reachable. The numeric reduce behind both is now a single exported
`reduceNumeric`.

`WIRE_RESHAPE_OPS`, `isWireReshapeOp`, `reduceNumeric` and
`AGGREGATE_DESCRIPTORS` are new exports; `EXPR_CALLS` is unchanged.
