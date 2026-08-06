---
"@vendoai/apps": major
"@vendoai/core": major
---

`vendo_make` has ONE engine. Assembly that produces no screen is the answer.

`ScreenOutcome.unavailable` used to fall through to the conductor, and so did an
unwired assembler, an assembler that threw, and an `assembled` that left no app
row behind. All four now end the ask with a FAILED `MakeReceipt` whose `say`
names what happened — the assembler's own `why` verbatim where there is one.

A quiet fall-through is how a composition bug ships: a deployment that forgot to
fill `apps.screen`, or whose assembler is broken, read all-green while every ask
was served by an engine nobody chose. It reads as broken now.

`escalate` is unchanged — it is a request for the builder, not the seam failing,
and a deployment with a sandbox still runs the build at the same app id.

**Migration**

- **`apps.screen` is required for `vendo_make`.** `createVendo()` fills it; a host
  composing `@vendoai/apps` directly must pass a `ScreenAssembler` or `vendo_make`
  will answer `status: "failed"` on every new-app request. `AppsRuntime.create`
  and `AppsRuntime.edit` are unaffected and still generate.
- **`conductCreate`, `conductEdit`, `ConductedApp`, `ConductedResult` and
  `ConductorOptions` are no longer exported from `@vendoai/apps`.** They were
  public for "external bench harnesses"; a reverse-dependency walk found no
  caller in this repo, the examples, the corpus harness or the docs. The pipeline
  still runs inside `createApps()` — it just has no public surface to be extended
  through.
- `generationPromptSections` (internal, `generation/contracts/sections.ts`) is
  deleted: no caller, and a second unmaintained description of the v2 tree
  contract is worse than none.
