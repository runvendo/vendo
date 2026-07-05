# Vendored dependencies

## fluidkit (ENG-205)

`fluidkit-<version>-<sha>.tgz` — the fluid-motion library the shell consumes as its
animation enhancement layer. fluidkit is unpublished and under active development, so
Flowlet pins an exact built artifact instead of a live path link (works on any
machine/CI, no dependency on a sibling checkout).

- **Provenance:** packed from fluidkit `main` at the SHA in the filename
  (repo: github.com/yousefh409/fluidkit), after a clean `npm ci && npm run build && npm test && npm pack`.
- **Consumed by:** `@flowlet/shell` via `"fluidkit": "file:../../vendor/fluidkit-<version>-<sha>.tgz"`.
- **Current:** `fluidkit-0.5.0-3310e48.tgz` — packed from the theme-provider branch
  (fluidkit PR #21). fluidkit 0.4.0 is on npm; swap this to `"fluidkit": "^0.5.0"`
  and delete this directory once 0.5.0 publishes.
- **Refresh procedure:** clone fluidkit main into a scratch dir → `npm ci && npm run build
  && npm test && npm pack` → copy the tarball here named `fluidkit-<version>-<shortsha>.tgz` →
  update the `file:` reference in `packages/flowlet-shell/package.json` → `pnpm install`.
  Delete the old tarball in the same commit.
- **Temporary:** this whole directory disappears once fluidkit is published to npm
  (tracked in the ENG-205 findings doc). Switch the dep to a semver range then.
