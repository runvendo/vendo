---
"@vendoai/vendo": patch
---

An inbound text is claimed in one round trip, not two. The delivery log decided
a claim by reading the row and then writing it, so every text on a hosted store
waited through two serial store calls before anything else could start — and two
genuinely concurrent copies of one delivery could each read the absence and both
run the person's turn, with a second tool call and a second charge behind it.
The claim is now the adapter's own guarded insert where there is one, which
answers both. An adapter that omits `atomic` keeps the read-then-write it always
had: slower, never different.
