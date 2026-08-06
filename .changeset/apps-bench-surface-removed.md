---
"@vendoai/apps": major
---

**BREAKING:** the bench host surface is removed from `@vendoai/apps` —
`loadDemoBankCatalog`, `loadDemoBankTools`, and `demoBankToolShapes` are no
longer exported. The `HostToolInfo` type stays.

The W1-bench experiments those loaders served have concluded (verdicts:
inline refs ADOPT; builder-calls, fetch-then-generate, CFG-JSX DEFER — the
ledger lives in the private repo), and the loaders themselves could never have
worked for an npm consumer: they resolved `examples/demo-bank/.vendo/*.json`
relative to this repo's layout, so every call outside the monorepo threw. The
one real caller (an internal bench harness, since moved out of this repo) now
loads the catalog and tools locally.
