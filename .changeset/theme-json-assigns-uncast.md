---
"@vendoai/apps": minor
"@vendoai/vendo": minor
---

`import theme from ".vendo/theme.json"` now assigns to `<VendoProvider theme>`
with no cast. Every quickstart paste used to carry `as VendoTheme` plus an
`import type { VendoTheme }` line beside it, because a bundler widens a JSON
module's string literals and `density`, `motion` and `typography.fonts[].source`
were exact literal unions. Those three fields now carry a `| (string & {})` arm,
so plain `string` assigns.

Autocomplete is unchanged: `"compact"`/`"comfortable"`, `"full"`/`"reduced"` and
`"next/font"`/`"public"`/`"google"` are still the values an editor offers.

On-disk validation is unchanged: `vendoThemeSchema` still parses the file
strictly, so a machine-written `theme.json` with a bad adjective still fails to
parse. The CSS mapping normalizes too — an unknown `density` renders as
`comfortable` and an unknown `motion` as `full`, adjective variable included,
rather than emitting a value nothing can read.

`vendo init`'s printed client hint drops the cast and the type import, so the
TypeScript paste is now the same paste JavaScript hosts get.
