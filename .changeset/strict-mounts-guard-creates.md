---
"@vendoai/harnesses": major
"@vendoai/store": minor
"@vendoai/core": minor
"@vendoai/vendo": patch
---

A strict mount guards its creates, a refused turn writes nothing, and eleven
exports nobody imported are gone.

`expectedRevision` on a workspace commit entry gains its third state: a number
compares, `null` means "this path must not exist yet", and the absent field
stays unguarded. The SQL backend already refused a create built on a base that
had moved; the hosted backend required a number and so degraded exactly that
case into an unguarded write, silently overwriting the colleague who created
the shared `/orgs` file first. Both backends and the memory reference are now
held to the same conformance case.

The per-turn refusal on a store that can serve neither the transcript nor the
workspace is atomic: the doors are resolved before the first write, so a
refused turn no longer leaves a `vendo_threads` row carrying the user's message
on a deployment that can never answer it.

`@vendoai/harnesses` drops eleven exports with no importer anywhere
(`abandonPendingApprovals`, `guardApprovalIds`, `addAgentTool`,
`buildAgentTools`, `guardedCall`, `previewApproval`, `computeInitialLoadout`,
`createToolSearchSession`, `CAPABILITY_MISS_TOOL_NAME`,
`createCapabilityMissDetector`, `scrubCapabilityMissText`). The `./vendo`
subpath is untouched.
