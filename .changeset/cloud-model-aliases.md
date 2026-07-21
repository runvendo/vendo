---
"@vendoai/vendo": patch
---

Vendo Cloud gateway calls now send curated model aliases instead of raw provider ids. The `VENDO_API_KEY` dev-mode rung requests `vendo-default` (Sonnet) by default; `VENDO_CLOUD_MODEL` picks `vendo-fast` (Haiku) or `vendo-strong` (Opus). The box's Cloud inference rung pins `vendo-default` the same way (`VENDO_INFERENCE_MODEL` still overrides). The gateway remaps any non-alias to `vendo-default` (with an `x-vendo-model-remapped` warning header) during a grace window and will reject non-aliases after it. BYO provider keys are unaffected and keep real model ids.
