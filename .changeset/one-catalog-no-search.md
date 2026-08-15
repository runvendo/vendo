---
"@vendoai/apps": major
"@vendoai/core": major
"@vendoai/vendo": major
---

The whole catalog is in the prompt, so `search_components` is deleted.

`references/format.md` now carries `catalogPrompt()` instead of `kitPrompt()`:
one line per component — name, summary, props by class with `!` on the required
ones, then its slots — plus the 227-name icon vocabulary no prompt has ever
carried. Measured on this base it costs 13,313 characters against the 20,819 the
per-brick sections cost for one fewer brick and no icons. A writer that can read
every component it may use, and every host component by name in its brief, has
nothing left to search for.

Removed: the `search_components` tool and its `VENDO_TOOL_TITLES` entry,
`VendoVerbPorts.searchComponents`, `searchRuntimeCatalog` and
`CatalogSearchMatch` from `@vendoai/vendo`, and `ScreenSurface.hasComponents` /
`ScreenAssemblerDeps.hasComponents` — the flag existed only to take the verb off
the loadout for a deployment with an empty catalog. `VENDO_VERB_TOOLS` is
`["validate", "schedule"]`.

Also removed: `catalogThemeSummary` and the `system.catalog` prompt slot behind
it. It was a second rendering of the host component list and the theme, aimed at
a thinker that renders nothing; `renderBriefingPack` is the one rendering, and
it hands the screen agent the theme tokens verbatim rather than a summary line.
