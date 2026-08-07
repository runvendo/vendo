---
"@vendoai/apps": patch
---

The apps contract now sits beside its implementation.

`createApps` was one 2,942-line closure, and the `AppsRuntime` interface it
implements sat ~2,000 lines above it in the same file — so reading any single
verb meant scrolling between two distant halves of `runtime.ts`. The contract and
the shapes its verbs speak move to `types.ts`, and four of the nested namespaces
(`access`, `inClient`, `review`, `pins`) each get their own module taking a small
shared context, the same shape `interchange`/`history`/`review` already use.
`pins` alone was 315 lines inline; its orchestration now lives in `pins-surface.ts`
beside the pure logic that was always in `pins.ts`.

Internal refactor only — the public surface is unchanged. Every type is still
exported from `@vendoai/apps` and still re-exported from `./runtime.js`, no
behaviour moved with the code, and the package's full suite passes untouched.
