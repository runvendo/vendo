---
"@vendoai/core": patch
"@vendoai/telemetry": patch
"@vendoai/engine": patch
---

Release pipeline hardening: the release gate now runs the PostgreSQL store
suite like CI does, and publishing uses npm trusted publishing (OIDC) with
provenance — no npm tokens anywhere. This patch is the first release cut
end-to-end by the automated pipeline.
