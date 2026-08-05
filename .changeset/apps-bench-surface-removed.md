---
"@vendoai/apps": major
---

**BREAKING:** the bench host surface is removed from `@vendoai/apps` —
`loadDemoBankCatalog`, `loadDemoBankTools`, and `demoBankToolShapes` are no
longer exported. The `HostToolInfo` type stays.

The W1-bench experiments those loaders served have concluded (their verdicts
live in `docs/eval/README.md`), and the loaders themselves could never have
worked for an npm consumer: they resolved `examples/demo-bank/.vendo/*.json`
relative to this repo's layout, so every call outside the monorepo threw. The
one real caller, `tools/genui-bench/fixtures/maple.ts`, now loads the catalog
and tools locally the same way its cadence sibling always has.
