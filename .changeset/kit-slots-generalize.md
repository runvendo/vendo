---
"@vendoai/apps": minor
"@vendoai/ui": minor
---

The Kit's `cell` slot generalizes: a component now DECLARES its slots, and the
checks floor reads that declaration instead of one hard-coded prop name.

`KitComponentSpec` gains `slots?: Record<string, KitSlotSpec>` — a doc, an
optional `content` vocabulary and a `perRow` flag per slot — and one table in
`specs.ts` states every place the Kit takes an element instead of a value:
`header`/`footer` on Surface, Card and Form, `rowActions`/`toolbar`/`empty` on
DataTable, `cell` where it already lived, `icon`, `marker`, `hint`, `prefix`,
`suffix`, `label`, `tooltip`, `legend`, and the `content` on a Tabs panel and an
Accordion section. Money, DateTime, Percent, Num, EnumBadge, Sparkline, Icon and
CodeBlock declare none, and take no element at all.

The `kit-nesting` check reads that table: an element in a declared slot is
measured against the slot's own vocabulary — the read-only value tier by
default, so a Button in a per-row `cell` is refused exactly as before — and an
element under a key no slot declares is refused by name instead of reaching a
renderer that would drop it. Tabs' and Accordion's element-valued `content`,
unchecked until now, goes through the same gate. `kitPrompt` prints the slots
from the same declaration, so the model is taught the table the floor enforces.
