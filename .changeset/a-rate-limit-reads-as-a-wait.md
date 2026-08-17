---
"@vendoai/core": patch
"@vendoai/store": patch
"@vendoai/ui": patch
"@vendoai/vendo": patch
---

A Vendo Cloud rate limit now reads as a WAIT everywhere, instead of vanishing.
The console answers 429 "Too many requests. Try again shortly." — and the OSS
side had nowhere to put that answer. The shared console client's wire-legal
code table omitted `unavailable`, so the console's own error code was not
forwardable and fell to each adapter's unknown-code tail, where four of the
five mint a PLAIN `Error`. A plain error fails `instanceof VendoError` at the
wire, so the request logged "[vendo] unhandled wire error", answered HTTP 501
("this operation does not exist") and showed the person the generic "couldn't
finish" overlay. An envelope-less 429 — the one an edge proxy sends as
plain text — had no reading at all.

`raiseCloudError` now forwards `unavailable` and `forbidden` as the
VendoErrors they are, and reads a bare 429/500/502/503/504 as `unavailable`
from the status alone, keeping the server's own sentence. 501 stays with each
adapter's tail: "this mount does not serve the op" is not a transient failure.
Nothing downstream changed — the wire's 503 mapping, the harness overlay and
the store's retry were all already written against that code.

Three places then act on it:

- The hosted store retries a rate-limited or transiently failed call once,
  waiting the console's `Retry-After` (capped at 10s, 250ms when it asked for
  nothing) and replaying the SAME `Idempotency-Key`, so the server dedupes a
  mutation it already applied instead of applying it twice. Before, only a
  timeout was retried.
- The batched Cloud uploader keeps a 429'd batch and sends it again, instead
  of reading every sub-500 answer as a permanent refusal and dropping it —
  which lost capability-miss and SDK-event reports exactly while an account
  was being rate-limited.
- The per-user limiter still fails CLOSED when the meter read fails, but no
  longer tells the user they reached the host's cap when nothing was counted:
  a busy meter denies with "Vendo Cloud is busy right now, so this limit could
  not be checked — this is temporary, not a cap", on the agent's refusal and
  on the person's card alike.

`VendoLimitPart` gains one optional field, `retryable?: true` (and its zod
schema the matching `z.literal(true).optional()`) — additive, so an older
consumer ignores it exactly as §15 forward-compat expects. It carries the one
distinction the card cannot make for itself: a limit REACHED keeps the
"You've reached your limit" headline, a limit that could not be CHECKED reads
"Couldn't check your limit" over the same detail line. Both chokes set it —
the message at the door and the generation mid-turn — so neither path can tell
the person a different story than the other.
