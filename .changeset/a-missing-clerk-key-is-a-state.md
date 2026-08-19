---
"@vendoai/vendo": patch
---

A keyless clerk() host is a state, not an outage. The preset used to THROW
when a request carried a session token and neither `CLERK_SECRET_KEY` nor
`CLERK_JWT_KEY` was set — 501-ing the entire wire in exactly the state
`vendo init --auth clerk` leaves you in, on hosts where Clerk's `__session`
cookie rides every request — while a forged token nine lines below resolved
to anonymous. A missing key now resolves to anonymous too, named once and
loudly in the server log (the v4-cookie-hint pattern). And because nothing
fails loud enough to send anyone looking, the gap is named early twice over:
init's detection attaches a clerk env advisory (the supabase mechanism,
generalized), and doctor grades the same fact statically as **E-AUTH-010**
(a warning) from the same shared helpers, so init and doctor can never
disagree.
