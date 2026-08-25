---
---

Test-only. Closes a coverage hole rather than changing behaviour, so it carries
no version bump: a real remix fork, painted by the real floor, is now read back
through the real `GET /apps/:id/open?pending=1` — the only open the embed ever
performs. Three suites bracketed that intersection and none covered it, which is
how a `blocked` refusal raised while painting could 403 the flagged poll forever
without a red test.
