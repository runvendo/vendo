---
"@vendoai/apps": major
"@vendoai/vendo": major
---

One briefing pack, assembled once, handed to both generation rungs

What a writer is told about the host's product is now a single object,
`BriefingPack` (`@vendoai/apps/contract`), rendered once by
`renderBriefingPack` and read by both rungs: the screen agent and the in-box
builder. It carries the theme verbatim, the host's design rules,
`.vendo/brief.md`, the component catalog one line per entry, and the
semantics-annotated tool shape card.

This closes two silent gaps. `.vendo/brief.md` never reached the screen agent
at all, and the in-box builder was told nothing about the brand, the rules, the
catalog or the tool shapes. Instructions stay per-rung — the screen agent's
dialect manual and the box's skin contract are different jobs.

Breaking:

- `@vendoai/apps` no longer exports `hostDesignBrief`. Compose a `BriefingPack`
  and call `renderBriefingPack` instead.
- `AppsConfig.designRules` is replaced by `AppsConfig.briefing`. `AppsConfig.theme`
  survives for the served-app `?vendoTheme=` handoff only.
- `GenerationDependencies` no longer carries `theme` / `designRules`, and
  `snapshotDesignRules` is removed with them.
- `ScreenAssemblerDeps`' `design` and `system` slots collapse into one
  `briefing` slot, and `ScreenInput` takes a rendered `briefing` string.

One removal a host can feel: the CONVERSATIONAL harness prompt no longer carries
the design brief. `createVendo()`'s composed `turn.system` used to end with the
`THEME TOKENS:` JSON and the `HOST DESIGN RULES:` block appended after the
system prompt; that suffix is gone. What still reaches that prompt is the
product brief and, through `catalogThemeSummary`, the host component lines plus
a one-line theme sentence (density, motion, typography) — but NOT the theme
token JSON and NOT `apps.designRules`. This follows from `claudeCode()` being
the harness that RUNS a box rather than the thing that decides what an app is:
the two writers that build apps — the screen agent and the in-box builder — both
read the briefing pack, so the house rules reach every writer through one
rendering instead of three. If your deployment relies on a `claudeCode()` turn
obeying `apps.designRules` while editing `app.vendo` with its own hands, that
turn is no longer told them; put those rules in `instructions` (`.vendo/brief.md`),
which still rides that prompt.

Otherwise host-facing configuration is unchanged:
`createVendo({ theme, apps: { designRules } })` and
`.vendo/{theme.json,design-rules.md,brief.md,catalog.json}` all still work, and
now reach both generation rungs.
