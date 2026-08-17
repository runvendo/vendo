---
"@vendoai/apps": patch
"@vendoai/vendo": patch
---

A deployment that cannot check screens now says so once, with the fix, instead of paying a model to rewrite a screen nobody read.

When `@vendoai/apps` cannot reach esbuild — the field case is a bundled host that never named it an external — the component gauntlet refuses every screen it is handed. That refusal used to travel as an ordinary finding: the screen agent relayed it to the writing model under "Fix each of these, then write the file again", the model rewrote a perfectly good screen, the next save was refused for the same reason, and the run ended in a generic "that build didn't come together" after burning its whole step budget. Nothing anywhere named the one thing that would have fixed it.

Three changes, one line of cause: the unavailability names its own remedy — keep `@vendoai/apps` out of the server bundle, which on Next is the `serverExternalPackages` list `vendo init` writes; naming `esbuild` alone does nothing, because this package hides that import behind a variable specifier and a bundler never sees an "esbuild" import to match — the gauntlet marks the refusal as the DEPLOYMENT's rather than the screen's, the checks floor carries the mark out (`ComponentPaintResult.environment`), and the screen agent ends the run on it — the floor's sentence becomes the answer the person and the host log both get, at a cost of one model call rather than a rewrite round per save.

All three of the gauntlet's machines are marked, because all three fail the same way: no compiler (`toolchain-unavailable`), no type checker (`typecheck-unavailable`), and an engine that would not START, which now has its own code (`engine-unavailable`) instead of sharing `run` with screens that ran.

A screen the floor refuses on its own merits is untouched — including one that RAN and threw, which is what `run` still means. Those sentences are still repair instructions, verbatim, because they are still repairable.

Also: a run whose every save was refused has no app row — a paint is what creates one — so its `decisions` have nowhere to land. That expected state is an info line now, in the same voice `commitSource` already uses for it, rather than a warning that sends an operator hunting for a broken memory door.
