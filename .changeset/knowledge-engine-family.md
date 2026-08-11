---
"@vendoai/knowledge": patch
---

The local lexical engine's drawers go through the `engine` family instead of the
generic record façade.

Generic `records.*` is a host's door onto its own data, and `vendoKnowledge` was
reaching for two of Vendo's own collections through it — `vendo_knowledge_docs`
and `vendo_knowledge_chunks`. Nothing in those calls said the collections were
Vendo's, so nothing could refuse a call that reached for one. Both drawers now
name their collection through `ops.engine.*`: the same verbs onto the same doors
with `assertEngineCollection` in front, so per-collection policy is unchanged.

`vendoKnowledge` takes an optional `ops` alongside `store` for that same store's
named-operation surface, when the composition could resolve one. Unset — which is what a
host constructing the engine with its own `StoreAdapter` gets, and what
`createVendo`'s knowledge seam still passes — the same seven verbs are served
straight off the adapter's own record doors through core's `engineOverAdapter`,
so a BYO adapter behaves exactly as before. An engine with neither still fails
loudly on the operation rather than reporting an empty corpus.
