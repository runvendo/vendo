# @vendoai/actions

Turns host APIs into agent tools that execute as the signed-in user. It owns
deterministic OpenAPI and route extraction, `.vendo` tool metadata, connectors,
and the runtime action registry.

Read [Connect API tools](https://docs.vendo.run/connect/api-tools) and
[Tools and safety](https://docs.vendo.run/concepts/tools-and-safety).

## Design notes

- **Furnished pin capture is bounded and source-owned.** A remixable registration may add a static JSON-compatible `sampleProps: { ... }` object. Sync follows JavaScript/TypeScript imports from the captured component for two local-import hops, applies the primary capture's realpath/in-root check to every file, and emits a named warning for unresolved, refused, or beyond-depth imports.
- **The style snapshot is deliberately narrow.** Sync captures direct local `.css` imports from canonical app roots only: `app/layout.*`, `app/root.*`, `pages/_app.*`, and their `src/` variants. It does not follow CSS `@import`, package CSS, or component-local stylesheet imports; the latter are named in sync warnings so rehearsal gaps stay visible.
- **Static pin misses are loud, never silent.** Sync resolves default, named/aliased, and namespace imports through named barrel re-export chains (es-module-lexer with a tolerant fallback), confined to the realpathed host root. When a remixable registration still cannot be resolved, the report carries a machine-readable `unresolvedPins` entry (`inline-component`, `component-not-imported`, `import-not-found`, `unsafe-source`, `unsafe-slot`) with a runtime-capture hint. A schema-valid runtime baseline or an explicit `.vendo/overrides.json` `remix.ignoreSlots` entry resolves the slot; otherwise the CLI exits non-zero.
