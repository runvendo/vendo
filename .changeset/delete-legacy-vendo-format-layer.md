---
"@vendoai/core": minor
"@vendoai/actions": minor
"@vendoai/vendo": minor
---

Delete the pre-v3 `.vendo` format layer and the semantics dev-server pass.

`.vendo/` is now one format, not two. The `vendo/tools@1` / `vendo/overrides@1`
schemas, `vendo/capabilities@1`, `vendo/semantics@1`, `vendoFileVersion`, and
every dual-format reader and in-memory migration fold are gone; the surviving
`@3` names lost their `V3` suffix (`toolsFileSchema`, `overridesFileSchema`,
`ExtractedTool`, `OverridesFile`, `VENDO_TOOLS_FORMAT`, `VENDO_OVERRIDES_FORMAT`
— now exported from `@vendoai/actions`, and the persisted tag strings
`"vendo/tools@3"` / `"vendo/overrides@3"` are unchanged).

`vendo sync` also no longer calls a running dev server to infer field
semantics: the `POST /sync/semantics` route and its CLI pass are deleted, so a
sync never executes host endpoints as a side effect. The per-tool `semantics`
field itself is untouched — sync's AI enrichment proposes it and
`overrides.json → tools[name].semantics` still wins forever.

Removed public types: `CapabilitiesFile`, `SemanticsFile`, `OverridesFileV3`
(use `OverridesFile`). Removed config: `createActions({ capabilities })`,
`createVendo({ profile: { capabilities, semantics } })` — compounds and briefs
live in `overrides.json`.
