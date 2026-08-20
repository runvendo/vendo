---
"@vendoai/core": minor
"@vendoai/harnesses": patch
"@vendoai/vendo": patch
---

On the sandbox rung, warming the chat now warms the machine the conversation
actually runs on. `POST /threads/warm` — the call the panel fires when the chat
surface opens — replays a real turn under a throwaway thread id, and the box
pool keyed on that id: so every warm call booted a real cloud box the user's
first message could never find, paid a full cold boot anyway, and left the warm
box idling its whole billed TTL before being destroyed unused. Warming cost a
box and bought nothing but the provider's prompt cache.

A warm turn's box is now parked as a warm SPARE, and the first real
conversation claims it: re-keyed to its own thread, liveness-probed on the way
in, and handed over exactly as a fresh box is — the workspace is materialized
and the session opened for that conversation, so nothing of the probe's turn
carries into the user's first message. A spare that died in the meantime falls
back to a cold boot, a second warm reuses the live spare instead of booting a
second box, and a spare nobody ever claims is reaped on the same idle budget as
any other box.

Each box now says how it was obtained, so the saving is greppable rather than
inferred: `harnesses.claude-code-box-ready` reports `thread-reuse`,
`spare-claim` or `cold-boot`, with the time it took.

`WARM_THREAD_PREFIX` is new in `@vendoai/core` — the thread-id prefix a warm
turn carries. It is what the pool reads to recognise one, since `Harness` is
deliberately unchanged: a warm turn is an ordinary turn, and the id is the
whole of the seam.
