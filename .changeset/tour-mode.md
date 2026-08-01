---
"@vendoai/vendo": minor
"@vendoai/agent": minor
---

Add tour mode: deterministic scripted responses in front of the live agent.

Every company that adopts Vendo has to demo it — to its own executives, to a
prospect, to a new user on day one — and a live agent is the wrong thing to put
in front of an audience. It is slow, it is different every time, and the one
run that matters is the run where it improvises. So every host builds the same
cache by hand, badly. This is that cache, supported.

`createVendo({ tours })` takes an ordered list of `{ prompt, respond }`
entries. `respond` is prose, a recorded app document, or a sequence of both,
replayed at a live turn's cadence. Everything a tour does not own — every
improvised question, every follow-up about what is on screen — reaches the real
agent untouched.

Two rules keep a tour from swallowing the demo it carries. An entry fires only
on a close variant of its own frozen prompt: matching is a normalized
similarity score over token sets and edit distance, not keyword presence, so a
typo still lands the entry while a different ask about the same subject does
not. And an entry fires at most once per thread, reconstructed from the
thread's own transcript rather than stored, so it survives the live turns in
between. Both rules exist because keyword matching cannot tell "ask for this"
from "change the thing you just made" — it replayed the recording on top of the
app the audience had just watched arrive, pin and all.

An app part is a real app: the recorded document is imported as an owned copy,
so it opens, pins, survives a reload, and can be edited by the next turn, which
is the live agent's. Pacing is measured against real turns and drawn from a
stream seeded by the entry's own prompt — uneven like a live provider, and the
same unevenness on every rehearsal. Nothing in a tour calls `Math.random`.

Plain OSS config with no Cloud dependency and no key-conditional branch: a tour
behaves identically with and without `VENDO_API_KEY`. A host that configures no
tours composes no seam at all.

`@vendoai/agent` gains the scripted-turn seam this rides on: an optional
`scripted` hook consulted after the thread resolves and before any model work.
It lives there because everything a scripted turn must share with a live one
lives there — the resolved thread, the persistence, the response contract — and
a seam in the wire route could only approximate all three. The umbrella owns
what a play is, because matching and replay need the apps runtime.
