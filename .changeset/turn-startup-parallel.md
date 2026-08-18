---
"@vendoai/harnesses": patch
"@vendoai/vendo": patch
---

A turn stops doing its setup one thing at a time. The system prompt is now
assembled BESIDE the turn's opening store reads instead of after them, and the
two independent waits inside it — the guard's directions and the knowledge index
— run together rather than in sequence; the assembled bytes are unchanged,
because section order comes from the assembler and not from which read settles
first. The runtime no longer re-validates the composed turn's transcript against
itself: composition hands it the very array it just read and validated, and one
array cannot differ from itself, so an O(n) double stringify per turn was
spent proving a tautology. `vendo()` projects the host's catalog once to set a
turn up instead of twice, and re-projects it after a tool call only when that
call could actually change what is reachable — the connector door — rather than
after every call.

Fixes a compaction accounting bug in the same pass: the prompt estimate billed
every equipped tool while the call only ever carries the active loadout, so a
curated surface was charged for a catalog it never sent — the trigger fired on
tokens that were never there, and the shed floor was handed a figure the prompt
had never reached. The estimate bills the active set now. The characters-per-token
ratio is unchanged.
