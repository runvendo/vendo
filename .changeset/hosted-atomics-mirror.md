---
"@vendoai/store": patch
---

`hostedStore` advertises guarded writes on every collection the engine actually backs with one. `records(collection).atomic` is a feature-detection signal — callers branch on its presence — and the hosted client offered it for `vendo_threads` alone, while the local engine has backed `vendo_apps` and `vendo_effects` with a revision counter since Wave 7. The wire already served both (`ops.engine.insertIfAbsent`/`compareAndSwap` delegate straight to the routed door, behind the same allowlist), so nothing was broken on the service side: hosted callers simply feature-detected `undefined` and fell back to the check-then-put those branches exist to avoid, on the two collections the service arbitrates properly. App-row lifecycle writes and schedule-fire claims lost their compare-and-swap; effect receipts lost their insert-once.

The mirrored set is now one named constant next to `RESERVED_COLLECTIONS`, and a parity test derives the truth from the local engine's real doors — it reads the mirror's list nowhere — so the next collection to gain or lose guarded writes fails the build rather than drifting the two sides apart again.
