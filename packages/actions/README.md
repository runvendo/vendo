# @vendoai/actions

Turns host APIs into agent tools that execute as the signed-in user. It owns
deterministic OpenAPI and route extraction, `.vendo` tool metadata, connectors,
and the runtime action registry.

Read [Connect API tools](https://docs.vendo.run/connect/api-tools) and
[Tools and safety](https://docs.vendo.run/concepts/tools-and-safety).

## Design notes

- **Furnished pin capture is bounded and source-owned.** Sync discovers `<Remixable>` wrappers in host source, resolves the single wrapped child through its static import, and captures under the child's exported identifier (`<Remixable review>` writes `review: true` into the baseline). It follows JavaScript/TypeScript imports from the captured component for two local-import hops, applies the primary capture's realpath/in-root check to every file, and emits a named warning for unresolved, refused, or beyond-depth imports.
- **The style snapshot is deliberately narrow.** Sync captures direct local `.css` imports from canonical app roots only: `app/layout.*`, `app/root.*`, `pages/_app.*`, and their `src/` variants. It does not follow CSS `@import`, package CSS, or component-local stylesheet imports; the latter are named in sync warnings so rehearsal gaps stay visible.
- **Static pin misses are loud, never silent.** Sync resolves default, named/aliased, and namespace imports through named barrel re-export chains, confined to the realpathed host root plus any configured extra source roots. A wrapped child that is not a single statically-importable component is a hard error: the report carries a `remixableErrors` entry naming the file and line, and the CLI exits non-zero. A wrapper whose `Remixable` cannot be traced to `@vendoai/ui` is reported instead as `pins.unattributed` — naming the file, line, specifier, and both fixes — and holds baseline pruning for that run. `.vendo/overrides.json` `remix.ignoreSlots` skips capture for a resolvable slot; `remix.sources` adds source roots outside the project root.
- **A host's own re-export shim is followed, not name-matched.** `Remixable` imported from one of the host's own modules is traced through its exports (`export … from`, `export *`, `import` then `export`, aliases, namespaces, tsconfig paths) back to `@vendoai/ui`. A chain that never reaches it is never captured, so a same-named component from elsewhere stays out.
