---
"@vendoai/core": patch
"@vendoai/harnesses": patch
"@vendoai/ui": patch
---

A timed-out approval ask settles as expired, not as the person's no. The
APPROVAL_WAIT_MS settle used to ride the ai-SDK's `output-denied` state — whose
meaning is "the person answered no" — so the thread narrated "you declined it"
for a question nobody answered, and the persisted part carried nothing that
could ever tell the difference. The settle now carries a typed outcome
(`status: "blocked"` with `cause: "expired"` — a field on the existing member,
not a new status, so already-published validators pass it through and older
chrome degrades to "wasn't allowed", which at least blames no one), the beat
reads "the approval expired unanswered", and the distinction survives reload
because the part settles as `tool-output-available` with the outcome on it.
The model-facing result is unchanged: the same denial naming the approval it
still needs.
