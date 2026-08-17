---
"@vendoai/apps": patch
---

A store that could not answer no longer reads as a build that produced nothing.

`create` and `edit` both prove an assembly by reading the app's row back: a paint is what creates the row, so no row means nothing rendered. Both reads swallowed every failure into that same conclusion — a rate-limited or dropped read became "the build produced nothing renderable", which tells the person their screen failed and sends them to rebuild work that assembled and painted fine.

Only an ABSENT row takes that path now. `engine.get` says absence with `null`, so a throw is the store failing and it is classified as what it is; the edit door's read-back distinguishes a genuine `not-found` from everything else and reports the store's own words otherwise. `buildFailureReason` gains the matching class: a `VendoError("unavailable")` — the server's own dependency saying "not now", including a cloud 429 — is "busy, try again shortly" and retryable, rather than "generation failed", which reads as a verdict on the ask.
