---
"@vendoai/core": minor
"@vendoai/apps": minor
"@vendoai/harnesses": minor
"@vendoai/vendo": minor
---

The screen agent: `vendo_make` starts in a cheap assembly loop, and the conductor
is what it falls through to.

Every request for something to look at used to go straight into the generation
conductor — a plan call, a fill worker per group, and the checking layer's two fix
rounds — whether the ask was a full app or one number on a card. Now the seam
routes: a lean loop assembles the document itself, and escalates when it cannot.

**The loop** (`screenAgent()` / `assembleScreen` in `@vendoai/harnesses`) is the
same `startTurn` call `vendo()` and `instant()` drive, with a small loadout and a
tight budget:

- **Assembly tools only.** The verbs by name (`search_components`, `validate`,
  `vendo_apps_data_list`, `vendo_apps_open`, `ask_user`) unioned with the host's
  `read`-risk tools. No mutating host tool, no build tool, and `vendo_make` itself
  is withheld — the screen agent is what it calls.
- **The host's own declared result shapes** ride the brief, off
  `ToolListing.outputSchema`, so field names are known before any query runs.
- **The shipped job description**, reused: `buildingAppsSkill` and its
  `references/format.md`, plus one short block correcting what is different here
  (no disk, no delegation, two files, one door out). There is no third prompt.
- **`SCREEN_STEPS = 10`.** An ask that needs more than that is an ask for a build.
- **No new write path and no new paint path.** It writes `app.vendo` through the
  workspace and the render seam's `commit()` proxy paints it, exactly as the
  `claudeCode()` harness already builds apps.

**Escalation** (`escalate`) writes `plan.vendo` and hands the ask on. The plan's
skeleton paints in seconds and becomes the build's first frame — no consent step,
one plain sentence, the work proceeds. `AppsRuntime.create` now accepts a
caller-minted `appId` so the escalated plan and the build that finishes it land on
one app and one view stream instead of two.

**The routing is an adapter slot, and it is default-safe.** `AppsConfig.screen`
takes core's new `ScreenAssembler`; composition is the only place that fills it
(`apps.experimentalScreenAgent: true`, host config only). `vendo_make` falls
through to `conductCreate` unchanged on every other answer — an escalation, an
assembler that could not run, one that threw, and an `assembled` that left no app
row behind. That last check is what makes the promise true rather than intended:
the row is the truth, so a screen agent that saved bytes nobody can render costs a
request nothing.

Screens run unsandboxed, by design: a description is data, its props are
schema-validated, and the kit treats them as inert.

New in `@vendoai/core`: `ScreenAssembler`, `ScreenRequest`, `ScreenOutcome`.
Edits go through the conductor as before — routing them needs the app's checkout
projection, which is not this change.
