---
"@vendoai/vendo": patch
---

`vendo doctor`'s mount-agreement check (E-CFG-003) now fires when the OpenAPI
spec declares a relative `servers[0].url` and `VENDO_BASE_URL` is unset.

It used to return early in exactly that case, so the check was silent in the one
posture that breaks. With no base URL the wire learns the bare request ORIGIN
(`onRequestOrigin`) and stored binding paths are prefix-free by law (spec
2026-08-06 §B1), so a path-mounted host serves every host tool one prefix short
of the real endpoint: every page renders and every tool call 404s. The existing
disagree/agree branches and the error code are unchanged.
