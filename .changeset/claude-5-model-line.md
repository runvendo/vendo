---
"@vendoai/apps": patch
---

Generation works on the Claude 5 model line. The engine hardcoded `temperature: 0` at every model call, but Claude Opus 5 / Sonnet 5 / Fable 5 (and Opus 4.7/4.8) removed the sampling parameters and reject the request outright with `400 — "\`temperature\` is deprecated for this model."`, so a host configuring any of those models could not generate at all. Sampling is now capability-gated on the model id: temperature is dropped only where the model rejects it and `temperature: 0` is preserved everywhere else. The same gate sets an explicit output cap on those ids, so a host whose `@ai-sdk/anthropic` predates the 5 line can no longer silently fall back to `max_tokens: 4096` and truncate a generated app mid-wire.
