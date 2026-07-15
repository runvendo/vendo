# @vendoai/actions

Turns host APIs into agent tools that execute as the signed-in user. It owns
deterministic OpenAPI and route extraction, `.vendo` tool metadata, connectors,
and the runtime action registry.

Read [Connect API tools](https://docs.vendo.run/connect/api-tools) and
[Tools and safety](https://docs.vendo.run/concepts/tools-and-safety).

## Design notes

- **Furnished pin capture is bounded and source-owned.** A remixable registration may add a static JSON-compatible `sampleProps: { ... }` object. Sync follows JavaScript/TypeScript imports from the captured component for two local-import hops, applies the primary capture's realpath/in-root check to every file, and emits a named warning for unresolved, refused, or beyond-depth imports.
- **The style snapshot is deliberately narrow.** Sync captures direct local `.css` imports from canonical app roots only: `app/layout.*`, `app/root.*`, `pages/_app.*`, and their `src/` variants. It does not follow CSS `@import`, package CSS, or component-local stylesheet imports; the latter are named in sync warnings so rehearsal gaps stay visible.
