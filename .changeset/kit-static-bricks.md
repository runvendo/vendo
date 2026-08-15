---
"@vendoai/apps": minor
"@vendoai/ui": minor
---

Six static bricks join the Kit, for the shapes a screen could only fake with a
Stack and a Text: `KeyValue`, `Timeline`, `Avatar`, `CodeBlock`, `EmptyState`
and `Steps`.

`<KeyValue record items/>` lays ONE record out as label/value rows — the detail
a table row expands into — and `<Timeline entries/>` runs a record history down
a dotted spine. Both take a `cell` slot on the DataTable contract: the slot
holds an element, the container publishes the record, and the components inside
name their field. `<Avatar name/>` draws initials in a tint hashed off the name,
so one person is one color everywhere, and adjacent avatars in a `Row` stack.
`<CodeBlock code language/>` shows a payload verbatim — no highlighting, no copy
button. `<EmptyState icon title description>` is the designed nothing-here with
the action that fixes it nested inside, and `<Steps items active/>` is the
progress trail, horizontal or vertical.

Every one is themed through the host's own `--vendo-*` variables and reads the
new `--vendo-border-width`, `--vendo-mono-family` and `--vendo-color-surface-raised`
tokens through a fallback, so an unthemed host is unchanged.
