---
"@vendoai/vendo": minor
---

`@vendoai/vendo` carries the `vendo` bin again — one install is the whole
surface. `npm install @vendoai/vendo && npx vendo init` works from a clean
directory, which it had not since the CLI moved to its own package.

The CLI is now part of the umbrella rather than `@vendoai/cli`, which is
withdrawn. `@vendoai/cli` never reached the registry: npm's OIDC trusted
publishing has no publisher to trust for a package that has never existed, so
every release from v0.57.0 on died at that step — after `@vendoai/core`,
`@vendoai/ui` and `@vendoai/vendo` were already live. Folding the CLI in fixes
the broken first-run and the broken release train in one move.

For hosts: nothing to do. Installing `@vendoai/vendo` now supplies the `vendo`
binary, so `init` no longer adds a second dev dependency for the `predev` and
`prebuild` hooks it writes. The extraction stages move from
`@vendoai/cli/extract` to `@vendoai/vendo/extract`.
