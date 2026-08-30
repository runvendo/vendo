# @vendoai/cli

## 0.59.2

### Patch Changes

- Updated dependencies [c9b76b5]
  - @vendoai/core@0.59.2
  - @vendoai/vendo@0.59.2

## 0.59.1

### Patch Changes

- Updated dependencies [f76f9e2]
  - @vendoai/vendo@0.59.1
  - @vendoai/core@0.59.1

## 0.59.0

### Minor Changes

- a41df02: **`@vendoai/apps` splits in two and retires: its contract half is
  `@vendoai/core`'s, its engine half is `@vendoai/vendo`'s.** The retired package
  stays published at 0.58.0, its last release — nothing you already installed
  stops working.

  Every symbol keeps the exact surface it had. Each door is republished whole at a
  subpath, so a migration is a specifier rewrite and nothing else:

  | was                      | is                            |
  | ------------------------ | ----------------------------- |
  | `@vendoai/apps/contract` | `@vendoai/core/apps`          |
  | `@vendoai/apps`          | `@vendoai/vendo/apps`         |
  | `@vendoai/apps/testing`  | `@vendoai/vendo/apps/testing` |
  | `@vendoai/apps/e2b`      | `@vendoai/vendo/sandbox/e2b`  |
  | `@vendoai/apps/edge`     | `@vendoai/vendo/sandbox/edge` |

  Most hosts need no rewrite at all: `createVendo`, `AppsConfig`, `AppsRuntime`,
  `EditResult`, `OpenSurface`, `SeedDrift`, `VersionEntry`, `SandboxAdapter` and
  `SandboxMachine` were already re-exported from `@vendoai/vendo` and
  `@vendoai/vendo/server`, and still are.

  **The contract half is `@vendoai/core`'s** — the app format, the Kit, and the
  browser-safe screen engine (`bootScreen`, `flattenTree`, `warmScreenEngine`,
  `evaluateExpr`, `KIT_SPECS`, `VendoTheme`, and the rest of what
  `@vendoai/apps/contract` exported). It moves because `@vendoai/ui` renders
  generated screens through that door and may not depend on the umbrella; core is
  the one package below both. `@vendoai/core/apps` is ESM-only, exactly as
  `@vendoai/apps/contract` was — it reads `import.meta.url` and resolves its
  WebAssembly through a package condition, neither of which CommonJS can carry, so
  it has no `require` leg. The `.` and `./conformance` entries are unchanged and
  still ship a CommonJS build.

  `quickjs.wasm` — the screen engine's WebAssembly — now ships beside
  `@vendoai/core`'s `dist` rather than `@vendoai/apps`'. A bundler that emits it
  for you needs no change; a host that copies it by hand should copy it from the
  new package.

  **The engine half is `@vendoai/vendo`'s**: app generation, checking,
  persistence, the runtime, the doors, the remix and automation authoring, and the
  two sandbox venues. `escalation/` and `edge/` land under the sandbox feature,
  which is why their subpaths are `/sandbox/e2b` and `/sandbox/edge` rather than
  `/apps/*`.

  **One user-visible configuration change.** `serverExternalPackages` no longer
  needs `@vendoai/apps`: the checker that reaches esbuild through a bundler-blind
  specifier is inside `@vendoai/vendo` now, which was already on the list. `vendo
init` writes the shorter line, `vendo doctor` checks it (E-CFG-004), and the
  docs and example configs follow:

  ```js
  serverExternalPackages: ["esbuild", "@electric-sql/pglite", "@vendoai/vendo"],
  ```

  An existing config that still names `@vendoai/apps` keeps working — the entry is
  inert once the package is gone — but `vendo doctor` will stop asking for it.

  **One symbol is newly reachable.** `zodShape` (with `ZodKind` and `ZodShape`) is
  exported from `@vendoai/core/apps`. It was package-internal before; the split
  put its two callers in different packages, so the door is the only place they
  can both reach it.

### Patch Changes

- Updated dependencies [a41df02]
  - @vendoai/core@0.59.0
  - @vendoai/vendo@0.59.0

## 0.58.0

### Minor Changes

- 812504f: **`@vendoai/store`, `@vendoai/actions` and `@vendoai/telemetry` fold into
  `@vendoai/vendo`; the store's routed collection names move to `@vendoai/core`.**
  `@vendoai/store` and `@vendoai/actions` stay published at 0.57.0 and
  `@vendoai/telemetry` at 0.6.0, their last releases — nothing you already
  installed stops working.

  Every symbol keeps the exact surface it had. Each block's own barrel is
  republished whole at a subpath of the umbrella, so a migration is a specifier
  rewrite and nothing else:

  | was                                | is                                       |
  | ---------------------------------- | ---------------------------------------- |
  | `@vendoai/store`                   | `@vendoai/vendo/store`                   |
  | `@vendoai/store/postgres`          | `@vendoai/vendo/store/postgres`          |
  | `@vendoai/store/test-util`         | `@vendoai/vendo/store/test-util`         |
  | `@vendoai/actions`                 | `@vendoai/vendo/actions`                 |
  | `@vendoai/actions/presets`         | `@vendoai/vendo/actions/presets`         |
  | `@vendoai/actions/presets/auth-js` | `@vendoai/vendo/actions/presets/auth-js` |
  | `@vendoai/actions/sync`            | `@vendoai/vendo/actions/sync`            |
  | `@vendoai/telemetry`               | `@vendoai/vendo/telemetry`               |

  `@vendoai/vendo/telemetry` keeps the `workerd` / `worker` / `edge-light` /
  `browser` conditions the old root export carried, so an edge build still gets
  the no-op client rather than the Node one.

  **ONE LINE IN YOUR `next.config` CHANGES.** `serverExternalPackages` named
  `@vendoai/store` because that package loads PGlite, and PGlite's Emscripten
  module breaks under production chunking. The package that loads it is
  `@vendoai/vendo` now:

  ```ts
  serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/vendo"],
  ```

  `vendo init` writes the new line and `vendo doctor` checks for it
  ([`E-CFG-004`](https://docs.vendo.run/production/troubleshooting/e-cfg-004)).
  An existing host keeping the old entry loses the containment, so update it.

  **Three names are now `@vendoai/core`'s**, because a contract a second process
  reads must be declared once: `RESERVED_COLLECTIONS`,
  `DEDICATED_RECORD_COLLECTIONS` and the `ReservedCollection` type. Core already
  spelled all thirteen of those collections as literals in
  `ENGINE_COLLECTION_REGISTRY`, so the one spelling now sits beside the registry
  that mirrors it. `@vendoai/vendo/store` re-exports all three, so an import
  through the store barrel is unchanged. The engine's PRIVATE routing facts stay
  with the engine: `RESERVED_CURSOR_COLUMNS` names physical columns, and
  `ATOMIC_RESERVED_COLLECTIONS` is not exported at all.

  Everything else is logic and stays in the umbrella — `createStore`,
  `createStoreOps`, `hostedStore`, the workspace and erase surfaces, the
  `ActionsRegistry` runtime, the connectors, `vendoSync` and the presets.

  `@vendoai/vendo` absorbs the runtime dependencies the three blocks brought with
  them (`@electric-sql/pglite`, `pg`, `aws4fetch`, `yaml`) and the actions block's
  optional `next` peer. Its own `@electric-sql/pglite` devDependency was `^0.2.0`
  and the store's dependency was `^0.5.4`; the umbrella takes `^0.5.4`, the one
  the store engine is written against.

  One wire-visible string: the MCP connector's `clientInfo.name` said
  `@vendoai/actions`, a package that no longer exists. It says `@vendoai/vendo`.

### Patch Changes

- Updated dependencies [973e89c]
- Updated dependencies [812504f]
  - @vendoai/core@0.58.0
  - @vendoai/vendo@0.58.0
  - @vendoai/apps@0.58.0

## 0.57.0

### Minor Changes

- 2f335d2: The CLI is its own package, `@vendoai/cli`. `vendo init`, `doctor`, `sync`,
  `config`, `knowledge`, `mcp` and the Cloud login move out of the umbrella, so
  `@vendoai/vendo` ships as a library only — its tarball no longer carries the
  CLI's compiled code, its `bin`, or the setup skills.

  **What a host does differently:** installing `@vendoai/vendo` no longer puts
  `vendo` in `node_modules/.bin`. Install `@vendoai/cli` next to it —
  `npm install -D @vendoai/cli` — which is also what the `predev` and `prebuild`
  hooks init writes (`vendo sync …`) resolve through, so it has to stay in the
  project rather than being run once through `npx`. A dev dependency is the right
  home: every `vendo` command runs at development or build time, never inside a
  request. `npx vendoai@latest …` is unchanged: the `vendoai` alias depends on
  `@vendoai/cli` and re-exposes the bin.

  `vendo init` now installs `@vendoai/cli` itself when it writes those hooks, the
  same way it already installs what the files it generates import — a project it
  wired can always run its own `npm run dev`. It installs the package unversioned,
  so your package manager records its usual caret range (`^0.56.0`): on a `0.x`
  version that is `>=0.56.0 <0.57.0`, so the CLI tracks patches within the minor
  you installed and never crosses one on its own.

  The extraction stages are `@vendoai/cli/extract` instead of
  `@vendoai/vendo/extract`.

### Patch Changes

- Updated dependencies [179fbf1]
- Updated dependencies [2f335d2]
- Updated dependencies [4b189ec]
- Updated dependencies [e679e1d]
- Updated dependencies [3c8b4e6]
  - @vendoai/vendo@0.57.0
  - @vendoai/core@0.57.0
  - @vendoai/guard@0.57.0
  - @vendoai/store@0.57.0
  - @vendoai/actions@0.57.0
  - @vendoai/apps@0.57.0
  - @vendoai/harnesses@0.57.0
