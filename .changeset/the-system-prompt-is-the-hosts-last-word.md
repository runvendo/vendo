---
"@vendoai/agents": minor
---

`agent({ system })` — the host's last word on the per-turn system prompt. It is called once per turn with the ctx and this package's own assembly (`{ assembled, directions }`); return a string and it is the prompt VERBATIM, return `undefined` and the default assembly stands. One hook covers both venues — `ctx.venue` says whether this is a chat turn or an away firing — so a deployment cannot drift into two agents wearing one name, and `undefined` meaning "the default" is what stops a conditional that falls through from silently stripping the base rules. `awayRunner({ system })` now takes the same two-argument shape and, where a hook returning `undefined` previously meant NO system prompt reached the runtime, it now means the default assembly: an away run is never promptless. Existing one-argument implementations are unchanged and still assignable. `assemblePrompt` and `PromptInput` are exported so a host replacing the prompt can rebuild the parts it wants to keep.

Also removed: `PromptInput.sourceNotes`, which had no callers and rendered a section nothing produced.
