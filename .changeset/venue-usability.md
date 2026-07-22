---
"@vendoai/apps": patch
"@vendoai/vendo": patch
---

fix(venue): e2b is only selectable when actually usable — 0.4.4 regression

`e2bInstalled()` treated a runtime without `import.meta.resolve` as "the
bundler inlined the SDK, so it must be available". Inside Turbopack/webpack
server bundles that fallback always fired, so a stray `E2B_API_KEY` (for
example inherited from the shell) flipped the venue ladder to an e2b the
runtime could never load, outranking the Vendo Cloud sandbox and killing
every server-app build — 0.4.3 printed `execution venue: cloud`, 0.4.4
printed `e2b` on the same host. The probe now tests usability instead of
importability: it asks Node's own resolver (`require.resolve` via
`process.getBuiltinModule`, which works inside server bundles), falls back to
a real `import.meta.resolve`, and reads an unverifiable runtime as NOT
installed — the SDK is never bundler-inlined (the mutable-specifier import
from the edge-portability work guarantees it), so the runtime resolver is the
only truth. With `VENDO_API_KEY` set and no usable e2b, the venue is the
Cloud sandbox again.

`vendo doctor` also stops false-blessing the venue: `execution venue: e2b`
now passes only when `E2B_API_KEY` is set and the `e2b` package resolves from
the project; otherwise it fails with E-LIVE-007 and a concrete fix line.
