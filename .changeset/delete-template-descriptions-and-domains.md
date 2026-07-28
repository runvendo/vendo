---
"@vendoai/core": minor
"@vendoai/actions": minor
"@vendoai/apps": minor
"@vendoai/vendo": minor
---

Delete template tool descriptions and the domains manifest.

`vendo sync` no longer invents a description for a tool your API does not
describe. The deterministic `"Use this to …"` generator is gone: an
undescribed tool carries `""` in `.vendo/tools.json`, which is the honest
keyless state. Sync's AI enrichment pass proposes real descriptions when a
model credential is present, and `overrides.json → tools[name].description`
still wins forever.

The domains manifest is gone end to end. Generation already receives the full
tool list, so a derived summary of tool nouns told the model nothing new — and
a finite `hasNot` can never enumerate what a host lacks. Removed: the `domains`
field from both `.vendo/tools.json` and `.vendo/overrides.json`, the
`DATA DOMAINS` prompt section, and the `domains` provider slot on the apps
runtime.

Removed public API: `DomainManifest` and `domainManifestSchema` (from
`@vendoai/core`); the `domains` field on `ToolsFile` / `OverridesFile`;
`createApps({ domains })`. `mergedSemanticsAndDomains` is now
`mergedHostSemantics` and returns the per-tool semantics record directly
(the `MergedHostSemantics` wrapper type is gone).

`.vendo/overrides.json` is strict, so a leftover `domains` key now fails
loudly at parse — delete it and re-run `vendo sync`.
