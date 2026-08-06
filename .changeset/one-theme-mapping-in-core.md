---
"@vendoai/core": minor
"@vendoai/ui": patch
"@vendoai/mcp": patch
"@vendoai/apps": patch
---

One theme→CSS-variable mapping, owned by `@vendoai/core`.

The same `VendoTheme` was flattened into `--vendo-*` custom properties in three
places — the ui chrome, the MCP door's connect/consent pages, and the MCP Apps
shim's `:root{}` block — each a hand-kept copy of the others, and they had
drifted: the door emitted 16 of the 32 variables the chrome does, so a themed
MCP page never saw `--vendo-color-scheme`, `--vendo-base-size`, the density
sizing scale, or the motion timings. `defaultVendoTheme`, `resolveTheme`,
`colorSchemeForBackground` and `themeCssVariables` now live in
`@vendoai/core` (and are exported from it); `@vendoai/ui` re-exports them
unchanged, and both MCP paths are a one-line serialization of the same call.
`VENDO_THEME_VARIABLE_NAMES` is read off that mapping, so the generation
prompt's brand-token line and the shim's reverse read cannot fall behind a
rename.

Two brand bugs fell out of the merge. The Kit's token fallbacks had `surface`
and `background` swapped, so an unthemed Kit painted a white page with
off-white cards inverted; its `fontFamily` fallback had also lost the Onest
brand stack. Both now derive from `defaultVendoTheme` instead of being retyped.

The phantom `--vendo-space-*` variables are gone. Nothing ever emitted them, so
every reference rendered its fallback; the door pages, the Kit's `Stack`/`Row`
gap, and the tree's notice and open-in-product card now use the real
`--vendo-density-*` variables where the scale matches, and the literal
elsewhere. Rendered output is unchanged.
