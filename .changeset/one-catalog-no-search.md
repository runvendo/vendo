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

Also gone: `catalogThemeSummary` — but only the half of it that duplicated. It
rendered two things. The host COMPONENT list was a second rendering of what
`renderBriefingPack` already hands the screen agent, and that half is deleted;
the pack is now the one and only rendering of that list. The one-line theme
summary was never a copy of anything — the pack hands the screen agent the theme
TOKENS verbatim, as JSON, for the rung that renders — so it stays, as
`themeSummary`, and the `system.catalog` prompt slot is renamed `system.theme`,
venue-gated exactly as before. A configured theme still reaches the system prompt
as `Theme: <density> density, <motion> motion, <font> typography.`
