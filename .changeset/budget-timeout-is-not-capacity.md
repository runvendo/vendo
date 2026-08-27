---
"@vendoai/apps": patch
---

A build that runs out of time says so, instead of blaming capacity.

A box gives one turn a fixed message budget, and a turn that outruns it throws
`unavailable` — the same code a genuinely busy service answers with. The
classifier that turns a build throw into the sentence on the person's failure
card read that code and nothing else, so it answered "busy, try again shortly"
for both.

For a busy service that sentence is true and useful. For a budget it is two
lies: the failure is not capacity, and waiting cannot help — a budget expires on
schedule, so the next attempt spends the whole window and dies at the same
mark. It also invites the retry it cannot survive; four escalated builds in a
row were reported this way, each dying at 15.2–15.4 minutes against a 15-minute
budget, on asks as small as "show a QR code".

Budget exhaustion is now told apart from capacity by the sentence the box throws
with it, and reported as "the build ran out of its time budget", non-retryable.
The number stays out of it: the bound is internal and a person cannot act on it.
