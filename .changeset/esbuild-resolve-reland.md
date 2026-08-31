---
"@vendoai/vendo": patch
---

**Screen checking works again on pnpm hosts.** The app checker loads esbuild
through a dynamic import, and a bare specifier resolves relative to the module
that contains it. While `@vendoai/vendo` sat in `serverExternalPackages` that
module was always the package's own file, so it always resolved; once the
umbrella had to leave that list (it has a `"use client"` half, and the list is
package-granular), its code was copied into `.next/server/chunks/`, whose
nearest `node_modules` is the app root — which npm flat-hoists esbuild into and
pnpm does not. Every pnpm host silently lost generated-screen checks with
`ScreenToolchainUnavailable`.

esbuild is now resolved from `@vendoai/vendo`'s own installation rather than
from wherever a bundler put the module, which finds it on either layout by
construction. Verified on real hosts under both package managers.

The `ScreenToolchainUnavailable` message no longer tells you to add
`serverExternalPackages` entries — that remediation is gone, and `vendo init`
already writes the list. It now names what actually failed and what actually
fixes it.

Re-landed: the code half of this fix was reverted by a release import before it
reached npm, so 0.61.1 published the old resolve under this description.
