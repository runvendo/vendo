---
"@vendoai/ui": minor
---

Extreme-content solidity (ENG-218): the thread stays smooth no matter how long
the transcript or how large a single message. Long threads are windowed — only a
bounded trailing slice of turns is in the DOM, with a "Show N earlier messages"
control that reveals the deferred head in chunks and anchors the viewport so the
reader is never yanked. Entrance animations are gated on restore, so reopening a
200-turn thread no longer fires every `fl-item-in` rise at once. Markdown is
memoized so a streaming turn only re-parses the block that changed instead of
re-parsing every settled turn per token, and a restored huge message (pasted
logs, model dumps) collapses behind a "Show full message" expander that bounds
both parse time and node count. Raw tool-payload previews in the approval card
are likewise capped. Stick-to-bottom and jump-to-latest are preserved under all
of the above.
