---
"@vendoai/vendo": minor
---

The in-process tool pack's `vendo_make` takes `slot`, like the MCP door's.

A host whose own agent runs in process could not say where a screen should land:
`slot` was on the door's `vendo_make` and missing from the pack's. It is now on
both, with the door's own wording, and reaches the same handler — the placement
claim rides `vendo_make`'s mint whichever door called it, so there is no second
path to keep honest. The pin tools stay door-only; on Path A you still move an
existing view from your own code with the app id.
