# @vendoai/cli

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
