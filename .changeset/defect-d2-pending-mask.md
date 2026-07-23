---
"@vendoai/vendo": patch
---

The wire's `open?pending=1` disambiguation now works on hosted (Vendo Cloud) store deployments and passes terminal build failures through to every caller (0.4.6 E2E cert defect D2). The existence probe behind the flag read through `appStore()` — raw SQL over a local db handle — which a hosted wire-door store doesn't have, so on Cloud-store deployments it answered false on every call and every owner-scoped not-found masked to `{"kind":"pending"}`: the #532 terminal failure records never resolved a non-owner poll, and the principal-mismatch diagnosis was unreachable. The probe now reads through the store adapter interface (every store shape serves it), and when the record carries the server-written `buildFailed` marker the wire answers `{"kind":"failed"}` with the persisted reason — a terminal failure is terminal for every caller. A genuinely absent record keeps answering `pending`.
