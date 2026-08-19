---
"@vendoai/agents": minor
"@vendoai/apps": minor
"@vendoai/core": minor
"@vendoai/guard": minor
"@vendoai/harnesses": minor
"@vendoai/knowledge": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

Vendo runs on both AI SDK majors. The peer range widens from `ai >=6 <7` to
`ai >=6 <8`, and the three things that made an `ai@7` host fail are gone: the
turn loop and the generation engine send their cacheable system block as
`system` instead of as a system-role message inside `messages` (ai@7 refuses the
latter with `AI_InvalidPromptError`, and both majors carry the same message form
— cache breakpoint and all — to the provider unchanged), and the spec-version
gates on provider failover and the screen agent's per-role seat now admit the
v4 spec that ai@7-era providers report instead of only v3.

`vendo doctor` follows: `ai@6` and `ai@7` both pass, a pre-v6 install still
fails on the peer floor, and E-DEP-001's ceiling moves to majors above the
supported pair. `vendo init` stops telling an `ai@7` host to downgrade, and the
"install your provider" line no longer names an `ai` major at all — `ai` is
already resolved by the time anyone can read it.

A new `ai-dual` CI lane pins the whole workspace to the ai@7 pairing and runs
the suites against it, so a peer range that claims two majors is checked rather
than asserted. This is the compat half of #478, whose short-term half was the
fail-fast this replaces.
