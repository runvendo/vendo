---
"@vendoai/vendo": patch
"@vendoai/apps": patch
---

A Claude 5 model pinned through the model ladder can generate again (#692).

`vendoModel()`'s lazy wrapper reports its family id (`"vendo-env"`) by design,
so model-params' Claude 5 allowlist never saw the resolved rung's real id: the
engine's `temperature: 0` rode through the ladder and a pinned Claude 5 model
(`VENDO_MODEL=claude-sonnet-5` with `ANTHROPIC_API_KEY`) rejected every call
with 400 "`temperature` is deprecated for this model". Sampling support is now
re-decided at call time against the RESOLVED rung — the one moment the real id
is known — dropping the sampling params such a rung rejects and setting the
explicit output cap that guards against a sampling-era provider's silent 4096
truncation. Sampling-era Claude and non-Claude rungs pass through untouched.
`@vendoai/apps` exports the capability rule (`acceptsSamplingParams`,
`UNKNOWN_MODEL_MAX_OUTPUT_TOKENS`) so the umbrella rides the engine's one
allowlist instead of a copy.
