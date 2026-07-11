# @vendoai/core

Framework-agnostic Vendo contracts and pure helpers. The package has no React dependency.

The main export includes:

- tool types and host API definitions, including OpenAPI conversion;
- `UINode`, generated UI payload validation, graph resolution, JSON Pointer bindings, and host-prop checks;
- the typed `UIMessage` stream protocol, consent records, fade proposals, and agent interfaces;
- component registry types and helpers;
- `.vendo/` host-install manifest schemas for theme, components, tools, and host events;
- runtime seam interfaces for storage, identity, execution, scheduling, and delivery;
- shared prompt assembly, capability summaries, output caps, and text helpers.

`@vendoai/core/testing` exports `createStubAgent()` for tests.

## Vendo GenUI v1

`GeneratedPayload` is a flat, id-addressed graph:

- `formatVersion` equals `VENDO_GENUI_VERSION` (`"vendo-genui/v1"`).
- `root` identifies the top node.
- `nodes` contains `{ id, component, source?, props?, children? }` records.
- `data` contains the view data. A prop shaped as `{ "$path": "/pointer" }` binds through JSON Pointer; any other value is literal.

```json
{
  "formatVersion": "vendo-genui/v1",
  "root": "stack",
  "nodes": [
    { "id": "stack", "component": "Stack", "children": ["t"] },
    { "id": "t", "component": "Text", "props": { "text": { "$path": "/title" } } }
  ],
  "data": { "title": "Welcome" }
}
```

Use `validateGeneratedPayload(input)` for non-throwing validation. `@vendoai/stage` renders the resolved `UINode` tree.

See [manifest contracts](../../docs/contracts/manifest.md) and [runtime seams](../../docs/contracts/seams.md).

Phase 1 direction: core slims to contracts only, while the app format and its runtime move to an apps package.
