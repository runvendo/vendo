---
"@vendoai/vendo": patch
"@vendoai/harnesses": patch
---

Two checks stop reporting a verdict they never reached.

`vendo doctor`'s render probe GETs the app origin's `/` and never reads the body, so a
status line is the whole observation. It failed on 5xx and blessed everything else as
"the app's root page renders" — which made `ok: the app's root page renders (HTTP 404)`
the line every healthy run printed, on the one status that means the server is saying
there is no page here.

A 5xx still fails `E-LIVE-006` unchanged; that is the crashing-site case the gate exists
for. A 4xx is now a note that names the status and says no page was reached, because a
host serving nothing at `/` — every page under a basePath, an auth layer in front — is
healthy, and doctor cannot tell that from a route you meant to have. That is the same
judgement the probe's own unreachable-origin branch already declines to make. A 2xx
passes as "answered HTTP 200": true, and the most this probe can know.

In the screen agent, a save that landed bytes the render seam would not paint was told
"validate found nothing to fix". `validateWrittenApps` is fail-open by design and returns
no failures both when validate passed and for every way it could not reach a verdict — a
guard that denied the call, an answer it cannot parse, a workspace that closed under it,
each reported to the operator only. The hand cannot tell those apart, so it no longer
claims to: it states the failed paint, which is the fact it has. When the gate did produce
findings, the note is still the repair instruction verbatim.
