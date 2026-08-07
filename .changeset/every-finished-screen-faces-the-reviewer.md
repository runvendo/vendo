---
"@vendoai/apps": minor
"@vendoai/harnesses": minor
---

Every finished screen faces the AI reviewer, with the data it renders.

A bills dashboard summed two overlapping query results into one headline: $11,216
on screen over ~$6,276 of real bills (demo-bank, 2026-08-06). Every mechanical
check passed, because a double count is not a shape error — the binding was well
typed, the field existed, the tool was real. The reviewer is the only check that
can see it, and it never ran: it fired only when the writing model volunteered to
call `validate({appId})`, and that run did not.

Two things change.

**The reviewer is no longer optional.** It runs at both places a screen is
finished — when the screen agent's assembly completes with a stored, painted app,
and at the built path's turn boundary where the validate gate already runs. Its
findings join the existing single repair round; there are no loops, and the
reviewer's own fail-open posture is untouched — silence, a refusal and a failed
request still all mean no findings, so a reviewer that could not judge never costs
a person their screen. It is deliberately still absent from the paint seam, which
runs on every save, and it is never spent on a document that did not pass the
mechanical floor or never reached the screen.

**The reviewer now sees the rows.** `validate({appId})` runs the app's own
`<Query>` tools — read risk only, through the same guard-bound registry the screen
itself reads from — and hands the results to the reviewer beside the printed
markup. Its rubric gained one rule: check every total, count and average against
those rows, including the overlap case where two queries return the same records
and both get summed.

The cost is exactly one reviewer model call per finished screen.
