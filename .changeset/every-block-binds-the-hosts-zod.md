---
"@vendoai/core": patch
"@vendoai/actions": patch
"@vendoai/automations": patch
"@vendoai/mcp": patch
---

Every block binds the host's zod. These four declared zod as a dependency only, while the other seven declared it as both a dependency and a peer of `>=3.25.0 <5` — and the peer is what makes pnpm bind the host's copy. So on a host that resolves zod 4, which `ai`'s own peer range admits, the seven bound the host's zod and the four kept their own: one package set, two zod instances. A schema built in one is not a schema in the other, so `@vendoai/core`'s `riskLabelSchema` inside `@vendoai/guard`'s `z.object` threw `Invalid element at key "risk": expected a Zod schema` and every tool call died before it started (#1314).

The four now declare the same peer, so there is one zod for all eleven. `scripts/dependency-guard.mjs` gains rule 5 to hold the posture uniform: a published block that bundles zod must declare that exact peer range.
