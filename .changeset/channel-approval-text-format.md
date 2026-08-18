---
"@vendoai/vendo": patch
---

The approval text reads like a text, not like machinery. The channel's ask
rendered the guard's raw preview — tool identifier and JSON blob included —
so a live $25.00 send asked for consent as
`host_transferMoney {"amount":2500,"recipient_name":"Jordan Avery"}`: a
voice-rule violation (the identifier reached the person) and a genuinely
dangerous read (2500 cents scans as twenty-five hundred dollars, in the one
message whose whole job is informed consent). The ask now renders one plain
line per argument, labelled from the host schema's own property description
when it has one ("Amount in cents: 2500") and the spaced-out key when it
does not; values stay verbatim — the ask is the safety boundary, so nothing
is paraphrased — capped only so one huge argument cannot flood a text. The
header also stops saying "needs your OK": the decider matches only YES/NO,
so a header that says OK teaches the one reply that would not decide it —
it now reads "needs your approval … Reply YES to approve, or NO to cancel."
