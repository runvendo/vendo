# Manifest contract

The dev tool (`npx flowlet init`, ENG-197) emits three artifacts into `.flowlet/` in the host repo (architecture Decision 3). `flowlet publish` assembles and uploads them as one immutable manifest to the cloud registry; sessions bind to a published manifest at init. Embedded mode reads `.flowlet/` from disk; publish is a no-op.

Source of truth: zod schemas in `packages/flowlet-core/src/manifest/`. Language-neutral JSON Schema artifacts are generated into `packages/flowlet-core/schemas/` (`pnpm --filter @flowlet/core generate:schemas`; a test fails CI if they drift).

## theme.json

Extracted host design tokens, fully resolved primitives only (the sandbox has no host CSS vars or fonts). Identical in shape to `BrandTokens` v1 in `@flowlet/components`; a conformance test keeps them in sync.

```json
{
  "version": 1,
  "accent": "#0A7CFF",
  "background": "#FFFFFF",
  "surface": "#F5F7FA",
  "text": "#111418",
  "mutedText": "#5B6470",
  "fontFamily": "system-ui, sans-serif",
  "radius": 8,
  "mode": "light"
}
```

## components/

Descriptor + wrapper pairs around the host's own components, compiled into the sandbox bundle. The published manifest carries only the serialized descriptors (`ManifestComponent`): `name`, `description` (drives LLM selection), `propsSchema` as JSON Schema. The compiled bundle travels alongside the manifest, referenced by the registry row, not embedded in it.

## tools.json

The host API surface as tool descriptors, plus host event types available as automation triggers. Developer-editable after extraction; validated on publish.

```json
{
  "version": 1,
  "tools": [
    {
      "name": "cancelInvoice",
      "description": "Cancel an open invoice.",
      "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } } },
      "annotations": { "mutating": true, "dangerous": true, "idempotent": true },
      "binding": { "type": "http", "method": "POST", "path": "/api/invoices/{id}/cancel" }
    }
  ],
  "events": [
    {
      "name": "invoice.paid",
      "description": "An invoice was paid in full.",
      "payloadSchema": { "type": "object", "properties": { "invoiceId": { "type": "string" } } }
    }
  ]
}
```

### Annotations

Required on every tool — a tool with unknown safety cannot be published.

| Field | Meaning | MCP hint mapping |
|---|---|---|
| `mutating` | writes host state | `readOnlyHint = !mutating` |
| `dangerous` | danger-gated: approval card interactively; pre-authorized scopes or async approval in automations | `destructiveHint = dangerous` |
| `idempotent` (optional) | repeat calls with same input are safe | `idempotentHint = idempotent` |

### Bindings

`binding` says how a call physically reaches the host API. Only `http` is frozen now (method + `{param}` path template, filled from the tool input by name). The discriminated union on `type` is the extension point for trpc/graphql extractors.

### Host events

Dot-namespaced names (`invoice.paid`). Delivered at runtime as signed webhooks from the host backend to the cloud worker (in-process for embedded). Consumed by the automations compiler as trigger choices.

## Published manifest and binding

`FlowletManifest` = `{ schemaVersion, theme, tools, events, components }`. Registry rows are immutable — a re-publish is a new row, keyed by tenant + version + content hash (`ManifestRef`), with an active pointer per environment. Sessions carry a `ManifestRef`, never a mutable manifest. Enterprise approval/diff (ENG-194) is a review queue over these rows.
