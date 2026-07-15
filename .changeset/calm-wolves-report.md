---
"@vendoai/core": patch
"@vendoai/agent": patch
"@vendoai/vendo": patch
---

Capture capability misses from embedded agent runs in a local JSONL sink and,
when a Cloud API key and telemetry consent are present, upload them in bounded
best-effort batches with the canonical enabled-tool surface.
