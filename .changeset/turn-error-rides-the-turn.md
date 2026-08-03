---
"@vendoai/core": minor
"@vendoai/agent": minor
"@vendoai/ui": minor
---

A failed turn now carries its own error, so the thread never shows a blank
reply.

When a turn's stream errored, the only trace on the wire was the ai-SDK `error`
chunk. That chunk belongs to no message: it sets `useChat`'s transient `error`
and nothing else. The turn itself persisted as an assistant message with **zero
parts**, so the moment the thread was re-read — a reload, a thread switch,
`VendoPage` refetching after the mint — the explanation was gone and the user's
question sat there answered by a blank bubble. On a keyless install that
blank bubble was the whole first experience: the server logged `Vendo found no
model key…`, the panel showed nothing durable.

The agent now writes the same gated string (`wireErrorMessage` — Vendo's own
crafted text or the fixed generic line, never provider internals) into the turn
as a `data-vendo-turn-error` part beside the error chunk. It persists with the
turn, and the thread renders it inline where the reply would have been, in the
failed-beat vocabulary a failed app build already uses. The live banner keeps
its Retry but drops its detail line while the turn is already saying it, so the
same sentence is never printed twice.

Additive to the wire (§15 forward-compat): consumers that don't recognize the
part ignore it.
