---
"@vendoai/harnesses": patch
---

A screen-agent save that never reached the screen now hears the floor, instead of
"app not found".

The paint seam refuses to paint a document that does not compile, does not render,
or does not pass the checks floor — and that refusal is also the reason the app has
no store row, because `AppsRuntime.authored` runs only on a paint. `save_app`
answered every landed commit with "Run validate on it now.", and `validate({appId})`
is row-scoped, so the assembly loop's one floor door replied `not-found` on exactly
the document that needed judging. Live 2026-08-06 ("a dashboard for my upcoming
bills and subscriptions") that is all the operator saw — `render seam: source did
not reach the store` and `validate failed: app not found` — while the loop, told
nothing, saved again and shipped a screen no door had judged.

The seam now records which apps a commit put on screen (`paintedIn`, beside the
commit rather than on `CommitResult`, which stays the store's own answer), and
`save_app` reads it: a save that did NOT paint runs the same gate the builder runs
before it reports done (`validateWrittenApps` → `validate({ document })`, no row
required) and hands the findings straight back. A save that DID paint is unchanged
and costs nothing extra — the seam already ran those checks before it emitted.
