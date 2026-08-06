---
"@vendoai/apps": major
"@vendoai/harnesses": patch
"@vendoai/vendo": major
---

refactor(apps)!: the brain dies — one router, one builder, zero middlemen

`AppsRuntime.create` and `AppsRuntime.edit` no longer run a generation pipeline.
They run the SAME engine `vendo_make` runs: the screen assembler in the
`apps.screen` slot. "The seam routes, not the caller" was never a `vendo_make`
property — it is the runtime's, and now every caller behind it (the HTTP wire,
the React client, a seed script) gets it.

- **`create`** asks the assembler first. `assembled` → the row it stored is the
  answer. `escalate` → the plan it wrote is the build's whole brief.
  `unavailable`, a throw, or an unfilled slot → an honest failure that says so.
- **`edit`** is the assembler opening the app's own `app.vendo`, rewriting it and
  saving it; the save lands through `AppsRuntime.authored`, so the store write,
  the checks floor and the paint are the shipped ones. An `escalate` on an
  existing app is the escalation ladder — an automation, or a box.
- **The machine lane briefs itself from the plan.** `<Server kind="steps" |
  "agentic" | "box" [served]>` is the escalating agent's own declaration and
  nothing re-derives it; a plan that escalated with no `<Server>` defaults to
  `kind="box"`, because the escalation is itself the claim that assembly cannot
  serve the ask. The in-box task carries the plan text verbatim, the person's ask
  verbatim, and the app's memory.

## Breaking

- **`apps.fill` (`{ model }`) is gone**, and so is the fast fill tier it named:
  the group fill workers it pointed at do not exist any more. `createVendo`'s
  `models.fill` seat (and its deprecated `paint.model` predecessor) are still
  accepted and validated, and are now **ignored** — nothing reads them — so a host
  config does not have to change in the same release. **Migration:** delete
  `apps: { fill: … }` from a direct `createApps(...)` composition, and drop
  `models.fill` / `paint` from `createVendo(...)` at your convenience. Nothing
  replaces them: there is one generation seat (`apps.model` / `models.default`),
  plus whatever the assembler's own harness uses.
- **`apps.screen` is required for `create` and `edit`, not only for `vendo_make`.**
  A deployment that composes `@vendoai/apps` without a `ScreenAssembler` now fails
  those doors loudly instead of quietly serving them from a second engine.
  `createVendo` fills the slot for you.
- `UNSTORED_APP_ID` is no longer exported from `@vendoai/apps`.
- An app row's `session` (the brain's transcript) is no longer written or read.
  Existing rows are unaffected until their next write, which drops it. An app's
  memory (`remember`) is what carries intent forward.

## Deleted

`generation/conductor.ts`, `generation/brain.ts`, `generation/fill.ts`,
`generation/prompts/`, `generation/contracts/sections.ts`, the island lane and
`laneGates` in `generation/lanes.ts`, `growSkeleton` / `spliceFragment` /
`Skeleton.slots`, `FIX_ROUNDS`, the commit-gate lead paragraphs, and the session
plumbing. `skeletonFromPlan` stays — it is the live plan-paint path at the render
seam.
