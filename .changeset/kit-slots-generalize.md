---
"@vendoai/apps": minor
"@vendoai/ui": minor
---

The Kit's `cell` slot generalizes: a component now DECLARES its slots, and the
checks floor reads that declaration instead of one hard-coded prop name.

`KitComponentSpec` gains `slots?: Record<string, KitSlotSpec>` — a doc, an
optional `content` vocabulary and a `perRow` flag per slot — and one table in
`specs.ts` states every place the Kit takes an element instead of a value:
`cell` where it already lived (a DataTable column, a CardList field, a KeyValue
field), `cell` and `marker` on Timeline, and the `content` on a Tabs panel and an
Accordion section. Every other component declares none, and takes no element at
all.

The table states only what the React Kit RENDERS. A slot the components do not
implement is worse than no slot: the prompt teaches the model to write it, every
check passes it, and the renderer drops it in silence — the same breakage the
table exists to refuse, arriving through the table. `@vendoai/ui`'s `test/kit/slot-drift.test.tsx` puts a probe in every
declared slot and fails unless it finds it in the DOM, so the declaration and
the implementation move together.

The `kit-nesting` check reads that table: an element in a declared slot is
measured against the slot's own vocabulary — the read-only value tier by
default, so a Button in a per-row `cell` is refused exactly as before — and an
element under a key no slot declares is refused by name instead of reaching a
renderer that would drop it. Tabs' and Accordion's element-valued `content`,
unchecked until now, goes through the same gate. `kitPrompt` prints the slots
from the same declaration, so the model is taught the table the floor enforces.

A slot is read at its DECLARED path and nowhere else. Each entry says where it
sits (`at: "columns"` → `columns[].cell`), and both the prompt and the check use
that one string — so a `cell` field on a ROW, which a DataTable never looks at,
is refused by name instead of being admitted as if it were the column's.

A component sitting in a slot is measured against its OWN spec, not just the
outer slot's vocabulary. It is a component in its own right: an element in a
prop it has no slot for, and children under a component that renders none, are
now refused inside a slot exactly as they are at the top of the tree. Both had
passed clean while the renderer dropped the descendant.

The renderer closes the matching gap: an element in a slot resolved only the
Kit, while the CHILDREN path resolved the Kit and the display bricks, so a brick
tag written into a slot painted nothing at all. `reifyElement` now reads the
same two registries `builtinContent` does.
