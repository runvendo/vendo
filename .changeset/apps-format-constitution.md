---
"@vendoai/core": major
"@vendoai/apps": major
---

The app format has one definition, and a test that fails when a mirror drifts

The format was kept by hand in four places — the contract, core's pinned limits,
the manual the agent reads, and the public docs — and they disagreed. The manual
promised "16 islands, 64 KB each" and never mentioned the **256 KB total** the
validator also enforces, so a build that obeyed the manual could exceed a budget
it was never told about and fail to validate for a reason it could not see.
Nothing about enforcement changed; the manual and the docs are now generated
from, and pinned to, the same constants.

**A generated component may now be a bundle, and nothing migrates.**
`AppDocument.components` values widen from `string` to `ComponentEntry` —
either the legacy bare source string or a `ComponentBundle`
(`{ source, modules?, styles?, sampleProps?, origin: "authored" | "seeded" }`).
Backward compatible **by construction**: a stored bare string still reads, and
every reader goes through `bundleOf(entry)`, which returns
`{ source, origin: "authored" }` for one. No document is rewritten, no version
is minted, and an app stored before this release opens unchanged.

*If you read `document.components` yourself*, that is the one change to make:

```ts
// before
const source = document.components?.[name];
// after
import { bundleOf, componentSources } from "@vendoai/apps/contract";
const source = bundleOf(document.components?.[name] ?? "").source;
const asSources = componentSources(document.components); // the whole map
```

`ComponentBundle`, `componentBundleSchema`, `ComponentEntry`,
`componentEntrySchema` and `bundleOf` are **declared in `@vendoai/core`**, beside
the `AppDocument` field they type — core's store conformance kit parses a stored
row with `appDocumentSchema` and cannot reach up into `@vendoai/apps`. The
contract door **re-exports** them and never re-declares them, so
`@vendoai/apps/contract` remains the one place to import the format from. Same
rule as `TREE_MAX_GENERATED_COMPONENTS` / `TREE_MAX_COMPONENT_SOURCE_BYTES` /
`TREE_MAX_TOTAL_COMPONENT_BYTES`, which are re-exported from core here too.

**BREAKING — the plan dialect loses two leaf fields.** `PlanLeaf` no longer has
`query` or `attrs`, and `<Leaf>` no longer parses a `query` attribute or
collects arrangement hints. Both were parsed and fact-checked with no downstream
consumer. A `<Leaf query="…" col="2"/>` still compiles — the extra attributes are
simply ignored — so no plan text breaks; only code reading `leaf.query` or
`leaf.attrs` does. The plan's top-level `<Query>` list and `<Cannot>` are
unaffected.

**New on `@vendoai/apps/contract`: the real validator surface.** `componentMapError`
and `utf8ByteLength` (the generated-component map rules, measured in UTF-8 bytes),
`SAFE_COMPONENT_NAME`, and `componentSources`. A consumer validating a component
map should call `componentMapError` rather than re-implementing the byte
accounting and the reserved-name check against `KIT_COMPONENT_NAMES`.

**The Kit vocabulary is one list.** `KIT_COMPONENT_NAMES` derives from `KIT_SPECS`,
`kitComponentNames()` returns that list instead of recomputing it, and
`WIRE_COMPONENT_NAMES` is `KIT_WIRE_COMPONENT_NAMES` re-exported — the same
binding, not a second array. All three names are still exported and their values
are unchanged.
