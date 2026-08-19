---
"@vendoai/store": patch
---

A wasm boot that never started gets the retry it already had a place for.
`PGlite.create`'s delayed retry only fired for `Invalid FS bundle size`, so
`PGlite failed to initialize properly` — the other way the engine intermittently
loses a boot — fell straight through. On a `memory://` store that is the end of
the line: no lock file, so the stale-lock heal above it rethrows on the spot, and
there is no recovery path at all. CI paid for it twice, killing one random test
out of ~300 in `packages/agents` on two unrelated branches with a byte-identical
stack.

Both signatures now share the one delayed retry. `Aborted()` deliberately does
not join them — it means a half-opened data dir and belongs to the stale-lock
heal — and only the truncated-bundle case is still reworded into the reinstall
message, so a second init failure arrives with its own text after exactly two
attempts.
