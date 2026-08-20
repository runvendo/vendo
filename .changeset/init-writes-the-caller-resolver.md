---
"@vendoai/vendo": minor
---

`vendo init` writes the caller resolver on the agent-loop arm. Init owns
`lib/vendo.ts`, and both existing-agent walkthroughs opened by telling the
reader to hand-add one export — `resolvePrincipal` — to the file init had just
written, because the chat route needs the caller and only the composition knows
how this host resolves one. `--use-case agent-loop` now emits it, over the same
identity the wire composed: a hoisted `const auth = <preset>()` shared with
`createVendo({ auth })`, or the hoisted demo `principal` when no provider was
detected. One binding, so the wire and your own loop cannot land on different
subjects — the mismatch that has no error and leaves the embeds polling a screen
nobody is shown.

The export appears on that arm only: the composition is one file across the
embedded, MCP and agent-loop arms, and a name none of the other readers import
is noise in their scaffold. The two quickstarts now describe the file rather
than add to it.
