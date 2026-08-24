---
"@vendoai/apps": patch
---

The checks floor stops re-describing a fault inside a callback as a fault in the
prop that carries it. A type error in an `onClick` body or a table's slot arrow
was anchored on the enclosing JSX attribute, so the refusal printed the prop's
declared signature against a value that already matched it — `prop "columns" on
<DataTable> takes a list of rows, but this value is a list of rows`. A sentence
that contradicts itself has no repair that satisfies it, so a model reading it
rewrites the one thing that was never wrong and is refused again, forever.

The attribute-shaped sentence now requires the fault to be about the attribute:
if a function boundary sits between the diagnostic and the attribute, the
compiler's own sentence stands instead — `line 4: <Button> prop "onClick" Type
'number' is not assignable to type 'string'.` A fault in a member of an inline
object or array literal the prop really is (`columns={[{ key, label: 5 }]}`)
still reads as the prop's own, because there it is.
