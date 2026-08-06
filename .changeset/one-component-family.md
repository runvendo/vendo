---
"@vendoai/ui": major
"@vendoai/core": minor
"@vendoai/apps": minor
---

One component family: the legacy prewired set is retired, and the Kit is the
only built-in vocabulary.

Vendo shipped two component families that shadowed each other by name. The
legacy prewired/branded set (`packages/ui/src/tree/{primitives,branded}.tsx`)
won every name collision, so the Kit's `Stat` could never format a value, its
`Text` was masked by a permissive one, and `DataTable`'s smart table sat behind
a plain `Table`. That set is gone. One family now, declared once by
`KIT_SPECS`, taught by `kitPrompt()`, resolved by the compiler, rendered by
`KIT_COMPONENTS`, and validated from the same schemas.

**Breaking — `@vendoai/ui/tree`.** These exports are removed: `Stack`, `Row`,
`Grid`, `Text`, `Skeleton`, `Surface`, `Divider`, `Card`, `Button`, `Input`,
`Select`, `Table`, `Badge`, `Stat`, `Tabs`, `PREWIRED_COMPONENTS`,
`BRANDED_COMPONENTS`, and their prop types. Import the components from
`@vendoai/ui/kit` instead — every name above except `Table` and `Skeleton`
exists there with theme-token styling and real prop schemas.

- **`Table` → `DataTable`.** The Kit table sorts, filters, searches,
  paginates, resolves dot-path column keys, and formats each cell. Its
  `columns` take `{key, label?, format?, align?}` objects rather than bare
  strings, `rows` is required, and `emptyLabel`/`rowKey` are `emptyState` and
  automatic respectively.
- **`Skeleton` is no longer a component.** A loading placeholder is renderer
  chrome, not something a tree names, so it moved inside
  `tree/forming-skeleton.tsx` and off the public surface. It marks itself with
  `data-skeleton` (it was `data-primitive="Skeleton"`).
- **`Tabs` keeps its tree contract.** The Kit `Tabs` now accepts the wire
  shape — string or `{value,label}` items, an initial `value`, and panels as
  CHILDREN in tab order — alongside its code-only `{label, content}` items.
  Tabbed apps are unaffected.
- **`data-primitive` is gone.** Every built-in marks itself with `data-kit`;
  tests and styles selecting on `data-primitive` must be retargeted.

**Reserved names now follow the Kit.** `RESERVED_COMPONENT_NAMES`,
`BRANDED_COMPONENT_NAMES`, and `PREWIRED_COMPONENT_NAMES` are removed from
`@vendoai/core`; `KIT_COMPONENT_NAMES` and `KIT_WIRE_COMPONENT_NAMES` replace
them, so a generated component may not shadow any Kit name.

Two schemas were widened where the retired family had been quietly absorbing
real usage: `Text.text` takes `string | number` (matching its `ReactNode`
implementation), and a single-segment `$state` read binds into any prop again
while `state.key.deeper` stays a compile error.

Stored apps naming `Table` or `Skeleton` render the contained
"Unknown component" notice on that node while every sibling still renders.
