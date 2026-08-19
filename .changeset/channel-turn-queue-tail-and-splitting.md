---
"@vendoai/vendo": patch
---

Three things measured on real texted turns, two of them time a person spent
waiting for nothing.

**The queue tail.** A texted turn holds its conversation's queue until it
returns, and after the reply had already gone out it still had two hosted round
trips to make: the link write, and the approval-feed read the grant-set offer
needs. Run one after the other they charged the NEXT text 8.3s of bookkeeping
before its own turn could start. They have nothing to say to each other — one is
this conversation's row, the other is the subject's approval feed — so they now
go together. The feed is still read after the turn and never before it: the
arming call that mints the rows it looks for runs inside the turn.

**The delivery-log sweep.** `ChannelEventLog.claim` awaited its own prune, so
once an hour, per conversation, whichever person's text happened to come due
waited out a page read plus one delete per expired row — 4.95s of serial hosted
calls in front of a turn that had not started. It is detached now. Safe on all
three counts: it only ever deletes rows older than any retry, so nothing a live
delivery reads depends on it; the cadence mark is set before it starts, so the
next claim this hour does not begin a second one; and a sweep that fails is
simply made again when the interval comes round.

**Splitting that actually engages.** The divider teaching landed on ONE turn in
four, so three times out of four a six-account listing arrived as a wall of
text. The teaching stays and stays first — a split the model chooses knows what
it is saying and a rule does not — but a reply it split nowhere is now cut for
it, once, at the end of the stream where the whole reply is in hand and it is
certain the model cut nothing. The boundaries are a blank line, then a line end,
then a sentence end, grouped to about one text each and capped at three; there is
deliberately no rung below a sentence, so a long unbroken clause comes back
whole rather than broken mid-thought. Only the true last piece carries `final`.

Cutting never reformats: each boundary captures the whitespace it matched, so a
bubble that holds two parts together holds the bytes that stood between them, and
a listing the model indented itself arrives indented. And the sentence rung knows
a period is not a sentence end half the time a bank reply uses one — it fires
only where the next sentence visibly starts, and never straight after a title, so
"your acc. 1234" and "Dr. Smith" stay whole.
