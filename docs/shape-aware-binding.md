# Shape-aware binding (vendo-genui/v2)

The most common generation defect is a component bound to fields the tool never
returns: the chart that renders but shows nothing. v2 closes that class
structurally with three pieces, all in `@vendoai/core`.

## Shape cards

A shape card is the structural type of one tool's response: field names, kinds,
nesting. Values are never stored.

```ts
import { deriveShapeCard, describeShape } from "@vendoai/core";

const card = deriveShapeCard("metrics_revenue", recordedSamples);
describeShape(card.output);
// "{ rows: { month: string, revenue: number }[] }"
```

- `deriveShapeCard(tool, samples)` builds a card from recorded response
  samples, merging across samples (fields missing in some become optional).
- `describeShape(shape)` renders the compact notation the generation engine
  embeds in the model's tool context.
- `ShapeType` is Json-serializable (`shapeCardSchema` validates stored cards).
- Unknown regions are the `json` kind. Everything downstream treats `json` as
  "check at runtime instead".

## Reshape pipes

Bindings in the wire may carry a bounded projection chain, so the model adapts
`{ month, revenue }` to `{ label, value }` without a code island:

```
<LineChart points={revenue.rows | asPoints(month, revenue)}/>
<Stat value={revenue.rows | sum(revenue) | format(currency)}/>
```

The vocabulary is closed, pure, and non-Turing (`RESHAPE_OPS`, chains capped at
`RESHAPE_MAX_STEPS`):

| op | meaning |
| --- | --- |
| `pick(f, ...)` | keep fields, per row on arrays |
| `rename(old, new, ...)` | rename fields pairwise |
| `asPoints(labelField, valueField)` | rows to `[{ label, value }]` |
| `format(kind)` / `format(field, kind)` | `number`, `currency`, `percent`, `date` (deterministic en-US) |
| `sum(f)` `avg(f)` `min(f)` `max(f)` `count()` | aggregates over rows |

Pipes compile to a canonical `$reshape` array on the `$path`/`$state` binding.
`validateTreeV2` rejects unknown ops and malformed chains, so the vocabulary is
enforced at the format gate. `applyReshape` evaluates chains at render time and
never throws.

## Compile-time check and per-binding repair

Pass shape cards to the compiler and mis-bindings become compile errors:

```ts
import { compileWireV2 } from "@vendoai/core";

const result = compileWireV2(wire, { toolShapes: { metrics_revenue: card.output } });
result.bindingErrors;
// [{ nodeId: "linechart-1", prop: "points", query: "revenue",
//    tool: "metrics_revenue", path: "/revenue/rows",
//    message: 'asPoints references "period", absent from the response shape',
//    missing: ["period"], available: ["month", "revenue"] }]
```

Each `BindingShapeError` anchors one broken binding (node, prop, tool, path)
and names the missing and available fields, which is exactly what a per-binding
repair prompt needs. The binding stays in the tree so repair can address it;
`bindingErrors.length > 0` is the engine's unshippable gate. A `shape-mismatch`
issue mirrors each error in `result.issues`.

Tools without a card are typed `json`: no compile error, runtime defense
instead.

## Runtime containment

Where no shape was known and the data still mismatches, the renderer applies
`$reshape` on resolution and the affected region renders a contained
"Data shape" notice instead of a broken component. Absent data (a query still
loading) passes through untouched and renders as before.

See it live: `packages/ui/e2e/harness` scenario `/tree-v2-shape`.

## Edits: one dialect

Edits use the same grammar (spec §5). The model sees the app printed as wire
markup with id anchors and emits a single `<Edit>` patch; there is no JSON ops
dialect.

```ts
import { printWireV2, compileWirePatchV2 } from "@vendoai/core";

const context = printWireV2(compiled, { includeIds: true });
// <App name="Cash overview">
//   <Stack id="stack-1" gap={14}>
//     <Stat id="stat-1" label="Revenue" value="$42k"/>
//     ...

const patched = compileWirePatchV2(`<Edit>
  <Set id="stat-1" label="Revenue (Q1)" value="$61k"/>
  <Insert into="grid-1" at={1}><Stat label="Overdue" value="3"/></Insert>
  <Remove id="button-1"/>
</Edit>`, compiled, { toolShapes });
```

Ops: `Set`, `Unset`, `Insert`, `Remove`, `Move`, `Query`/`RemoveQuery`,
`Island`/`RemoveIsland`, `SetName`. The apply is deterministic and total: a
bad op is skipped whole with an issue, untouched nodes keep object identity
(hot-swap keys off stable ids), inserted nodes mint fresh ids past the
existing ordinals, and the result re-validates through `validateTreeV2` plus
the shape check above, so a bad edit is as unshippable as a bad create.
Callers may declare `extensionOps` (the engine's `ForkPin`/`SetDescription`)
that parse in the same grammar and come back in `result.extensionOps` for
engine-policy application.

See it live: harness scenario `/tree-v2-edit`.
