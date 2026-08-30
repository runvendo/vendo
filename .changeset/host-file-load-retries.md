---
"@vendoai/actions": patch
---

A failed first read of `.vendo/tools.json` (or `overrides.json` / `judgments.json`) no longer freezes the host-tool surface for the life of the process. The next request retries; a successful load still sticks until restart.
