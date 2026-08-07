---
"@vendoai/harnesses": minor
---

The screen agent ships one door, and the tool bridge stops currying for a caller
that no longer exists.

`screenAgent()` is removed from `@vendoai/harnesses`. The file shipped two doors
into one assembly loop, and only `screenAssembler()` — the `vendo_make` route
composition fills — was ever wired. The unused door had already drifted from the
live one: it never passed `design`, so a screen assembled through it lost the
host's theme brief, and it passed `turn.system` straight through, the
conversational prompt the live door deliberately withholds from a writer loop. A
door that nothing calls cannot be found wrong by anything, so it silently became
the wrong door. `assembleScreen`, `screenAssembler`, `escalatedPlanPath`,
`ScreenSurface`, `ScreenInput`, `ScreenResult` and the three tool-name constants
are unchanged and still exported.

Inside the package, `buildAgentTools` and `addAgentTool` are gone with it. They
built an ai-SDK `ToolSet` for a path this repo stopped taking — the harness
runtime calls the bridge directly, and `find_tools` builds its own tool — and
their existence was the entire reason `guardedCall` and `previewApproval` were
curried factories rather than plain functions. Both now take the call arguments
directly (`guardedCall(descriptor, options, input, { toolCallId })`,
`previewApproval(descriptor, options, input, { toolCallId }, onAsk?)`); both live
callers invoked the returned closure on the very next expression, so this is
behaviour-neutral. `onAsk` is unchanged, and neither function was ever on the
barrel.
