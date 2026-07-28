---
"@vendoai/ui": patch
---

A turn that builds nothing no longer looks like it is building something.

Between send and the first streamed chunk the thread painted a document-shaped
skeleton card under a "Generating…" label. That window has no idea yet whether
the turn will produce a view: on the live demos it showed on every turn, then
resolved into plain prose or a refusal, which read as a generated view that had
failed to arrive.

The pre-first-chunk window now uses the same quiet liveness indicator every
other waiting moment in a turn already uses, so the transcript promises nothing
it may not deliver. Nothing changed about how a real build narrates: tool calls
still speak through the status ribbon, and a forming generated view still shows
"Building your view…" on the app card until it settles.

`.fl-generating` and the `.fl-skeleton` card are removed from the chrome
stylesheet (`.fl-skeleton-bar` stays — the markdown table's forming row uses
it). The internal `MessageList` no longer takes `awaitingFirstChunk`.
