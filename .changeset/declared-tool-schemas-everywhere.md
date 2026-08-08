---
"@vendoai/actions": patch
"@vendoai/apps": patch
"@vendoai/core": patch
"@vendoai/harnesses": patch
"@vendoai/vendo": patch
---

`.vendo/tools.json` is the one source of truth for every tool's request and
response schema, and the runtime sampler is gone.

Sync fills both slots through a trust ladder and records which rung filled each
one: the host's own spec (`declared`), its TypeScript types (`types`), the AI
judge reading the handler (`inferred`), or nothing (`unknown`). The judge may
only fill a slot nothing else could read — refused in code, not by prompt — and
its fills survive the next sync through the same carry-over `semantics` uses.
Coverage is reported plainly by `vendo sync`.

Every prompt that lists tools now lists all of them: a tool with a declared
schema shows its shape, and a tool with a blind slot says so in words. A blind
input never prints as `{}`, which reads as "takes no arguments" — and a
declared no-argument tool still prints the empty schema it really has.

**Breaking, both pre-1.0:**

- `AppsConfig.connectedToolkits` is removed from `@vendoai/apps`. Its only
  reader was the create-time shape sampler, which is deleted: nothing calls the
  host to learn a shape anymore. Drop the option; there is no replacement and
  nothing to migrate.
- `deriveShapeCard`, `deriveShape`, `mergeShapes`, `ShapeCard` and
  `shapeCardSchema` are removed from `@vendoai/core`. Shapes come from declared
  JSON Schema now — use `shapeFromJsonSchema(schema)`, which additionally keeps
  `enum` values a sample always erased.

A host that declares its response schemas gets strictly better checking and one
fewer live call per create. A host that declares nothing keeps working: blind
tools run permissively, and the report says which ones they are.
