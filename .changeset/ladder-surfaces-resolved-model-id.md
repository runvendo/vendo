---
"@vendoai/vendo": patch
---

A model pinned to the Claude 5 line through the ladder generates again.

`vendoModel()` hands back a lazily-resolving model, and its `modelId` was the
seam's own placeholder — the literal `vendo-env` — until the rung resolved. But
the id is not decoration: the generation engine reads it to decide HOW to make
the call, and the Claude 5 line rejects `temperature` outright. A placeholder
reads as "not a Claude model", so `VENDO_MODEL=claude-sonnet-5` with a provider
key kept `temperature: 0` and every single generation came back
``400 `temperature` is deprecated for this model``. Sonnet 4.6 hid it by
accepting the parameter, which is why the default ladder never showed it.

The wrapper now reports the rung it will actually call: the resolved model's own
id once resolution has run, and before that the id resolution will pick, which
the ladder can answer without waiting because credential detection is pure env
reading. Nothing else moves — the same precedence chooses the id, the announce
line still prints it, and a rung with no credential keeps the placeholder
because there is no real id to give. Hosts on a sampling-era model see exactly
what they saw before.
