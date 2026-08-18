---
"@vendoai/ui": patch
---

A settled approval receipt names the data it got back. The receipt built its rows
with the same body the ask uses, and that body calls a value with no name of its
own "Input" — so an approved `getTodos` listed the returned todos under "Input",
as if the list were what the person had agreed to send. Rows on the way back are
labelled "Result". A call that returned a bare value now shows it at all, too:
the object-only guard in front of those rows showed a person nothing, which is
exactly the data-chosen body §16 law 1 exists to prevent.
