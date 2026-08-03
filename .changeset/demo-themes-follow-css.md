---
---

Maple (`examples/demo-bank`) and `examples/demo-template` carried
`.vendo/theme.json` values that disagreed with their own CSS (`border`,
`fontFamily`), so every build warned once sync started re-extracting the theme.
The CSS is the truth: both themes now hold what the deterministic extractor
reads, and each app commits its `.vendo/theme.extracted.json` merge base so a
subsequent `vendo sync` is a no-op.
