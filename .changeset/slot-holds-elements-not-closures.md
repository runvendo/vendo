---
"@vendoai/apps": patch
---

A closure written into a Kit slot fails the screen check instead of painting a blank cell. `cell: (row) => <Money/>` is the React-shaped wrong answer, and the screen VM serializes any function prop as a `$handler` door — so the table was handed a callback where an element belonged and rendered empty cells while compile, types, paint and tree all passed. A slot's zod schema now carries a marker the component screen's typings read, so a slot prints as an element type rather than `any`, and the refusal names the slot, the column it sits in, and the element to write instead. `Tabs.tabs[].content`, `Accordion.items[].content` and `Tooltip.content` spelled their own `z.unknown()` rather than the shared slot, so each was the same hole; they share it now.
