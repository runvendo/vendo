---
"@vendoai/core": minor
"@vendoai/apps": minor
"@vendoai/vendo": minor
"@vendoai/ui": minor
---

A parked press gets its answer: the approval modal, the refresh on resolution, and the animated landing.

A guarded action pressed on a generated screen parked for approval and then
dead-ended twice over: the ask had no UI anywhere on the page (only a badge
count), and once someone approved it — over the wire, from the chat card — the
action ran server-side while the screen sat on "Sending…" and stale numbers
forever. The resumed call's outcome was simply discarded.

Now the whole loop closes. The apps runtime persists what became of a parked
call (`PARKED_CALL_OUTCOME_COLLECTION`, shared with the BYO lane so both write
the same rows), `GET /approvals/:id` serves it — answering `pending` while the
resumed call is still running, so the decide window reads as what it is — and
the screen watches its own parked presses: on `executed` it re-reads its query
plan and repaints backend truth; on `declined`/`expired` it re-reads too, so a
screen whose own state latched "sending" re-arms instead of locking forever.

The ask itself is a centered modal, mounted wherever screens mount (slot, chat
card, workspace stage, BYO embed, remix): the ask at hero size, Approve/Deny,
a designed in-flight state for the seconds the decision takes to run, and a
queue so burst presses ask one question at a time. Esc closes without deciding
— the pending notice on the pressed control is now pressable and re-raises the
ask. `ApprovalResolution`'s pending arm may now omit `request` (the decide
window has no ask left to show); consumers skeleton or fall back.

Refresh repaints animate: an arriving row opens under a fading highlight, a
leaving row collapses and returns its gap, and numeric leaves roll to their new
figure — repaints only, never first paint, never streams, and never under
`prefers-reduced-motion`.
