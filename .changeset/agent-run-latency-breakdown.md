---
"@vendoai/core": patch
"@vendoai/harnesses": patch
"@vendoai/vendo": patch
---

A slow turn now says WHERE it was slow. `agent_run` carried one wall-clock
number and a `steps` field hardcoded to `0`, so the only honest answer to "why
did that take nine seconds" was to guess. It now carries `ttftMs` — how long
the person waited for the first word — plus the five phase marks the wall time
splits into (`storeMs`, `promptMs`, `modelMs`, `toolsMs`, `guardMs`), and
`steps` is the turn's real model-call count. `durationMs` starts at the top of
the turn rather than after the opening store reads, which is why a slow store
used to be invisible in it. Durations and counts only: a breakdown says how
long, never what was read, prompted, thought, called or judged.
