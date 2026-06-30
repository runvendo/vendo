# @flowlet/core

Flowlet's framework-agnostic contracts: the MCP-shaped tool interface, the `UINode`
composition model, the stream protocol (reuses the `ai` SDK `UIMessage` + typed
`data-*` parts), the `FlowletAgent` interface, the component registry, and a scripted
stub agent. No React. See `docs/superpowers/specs/2026-06-29-flowlet-f1-foundation-design.md`.

## Flowlet GenUI v1 format

The declarative payload an LLM emits as the `payload` of a `generated` UINode. It is a
flat, id-addressed graph:

- `formatVersion`: must equal `FLOWLET_GENUI_VERSION` (`"flowlet-genui/v1"`).
- `root`: the id of the top node.
- `nodes`: a flat array of `{ id, component, source?, props?, children? }`. Each node
  names a registered component by `component` + `source` (`"prewired"` for built-in
  primitives like `Stack`/`Row`/`Grid`/`Text`/`Skeleton`, `"host"` for bundle components).
  `children` lists child ids; the graph is nested at resolve time.
- `data`: the data model. A prop value of the form `{ "$path": "/pointer" }` binds to it
  via JSON Pointer; any other value is a literal.

```json
{
  "formatVersion": "flowlet-genui/v1",
  "root": "stack",
  "nodes": [
    { "id": "stack", "component": "Stack", "children": ["t"] },
    { "id": "t", "component": "Text", "props": { "text": { "$path": "/title" } } }
  ],
  "data": { "title": "Welcome" }
}
```

Validate with `validateGeneratedPayload(input)` (pure, never throws); `@flowlet/stage`
resolves the flat graph into the nested `UINode` tree the sandbox renders.
