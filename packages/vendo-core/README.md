# @vendoai/core

Vendo's framework-agnostic contracts: the MCP-shaped tool interface, the `UINode`
composition model, the stream protocol (reuses the `ai` SDK `UIMessage` + typed
`data-*` parts), the `VendoAgent` interface, the component registry, and a scripted
stub agent. No React. See `docs/superpowers/specs/2026-06-29-flowlet-f1-foundation-design.md`.

## Vendo GenUI v1 format

The declarative payload an LLM emits as the `payload` of a `generated` UINode. It is a
flat, id-addressed graph:

- `formatVersion`: must equal `VENDO_GENUI_VERSION` (`"vendo-genui/v1"`).
- `root`: the id of the top node.
- `nodes`: a flat array of `{ id, component, source?, props?, children? }`. Each node
  names a registered component by `component` + `source` (`"prewired"` for built-in
  primitives like `Stack`/`Row`/`Grid`/`Text`/`Skeleton`, `"host"` for bundle components).
  `children` lists child ids; the graph is nested at resolve time.
- `data`: the data model. A prop value of the form `{ "$path": "/pointer" }` binds to it
  via JSON Pointer; any other value is a literal.

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

Validate with `validateGeneratedPayload(input)` (pure, never throws); `@vendoai/stage`
resolves the flat graph into the nested `UINode` tree the sandbox renders.

## Contracts

Frozen platform contracts (2026-07-01 architecture):

- `src/manifest/` — the `.vendo/` manifest schema (theme.json, components, tools.json
  + host events) as zod schemas; generated JSON Schema artifacts in `schemas/`
  (`pnpm generate:schemas`, drift fails CI). See [docs/contracts/manifest.md](../../docs/contracts/manifest.md).
- `src/seams/` — the five runtime seam interfaces (Store, CredentialBroker, Executor,
  Scheduler, Channels) with the embedded-vs-cloud mapping in TSDoc. See
  [docs/contracts/seams.md](../../docs/contracts/seams.md).
