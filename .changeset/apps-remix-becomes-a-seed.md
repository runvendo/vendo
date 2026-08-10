---
"@vendoai/apps": minor
"@vendoai/core": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
"@vendoai/actions": minor
"vendoai": minor
---

Remix is a seeded app: the pins subsystem is gone

An app that was made from one of your components no longer carries a list of
"pins". It carries a single `seed` — the component it started from and the
version of that component it started at. A remix is an ordinary app that
happens to start from something, so it is created, validated, edited and
versioned through exactly the same doors as every other app.

**Behaviour change you will notice: updating a remix now replaces it.**
When the host component changes, the remix reports drift as a warning and
nothing happens on its own. If you choose to update, you get the pristine new
component — the edits you made to that component are replaced. The previous
release replayed your recorded edits on top of the new version; that machinery,
its preflight and the version trail feeding it are deleted. Drift is a warning,
and updating is always your choice. The UI says this in the drift banner, and
the agent tool's description tells the model to say it too.

**Behaviour change on admission.** Every write path now runs the same document
validation, seeded and forked apps included. Seeded bundles used to skip the
island gate entirely, so a capture the jail could never render was accepted
without complaint. Captures that produce invalid documents will now be refused.

**Fixed.** A seeded app whose host component had moved on used to open with no
imports, no sub-modules and no styles — silently. Those furnishings were
hash-matched against the live baseline at open time, so any drift lost them.
They now travel inside the stored component bundle. Separately, artifact export
dropped remix provenance because the interchange field whitelist never listed
it, so export-permission checks never ran.

**Renames.**
- `AppDocument.pins?: Pin[]` → `AppDocument.seed?: AppSeed`
  (`{ component, baseline, slot?, review? }`). `Pin` and `pinSchema` are removed;
  `AppSeed` and `appSeedSchema` replace them. `forkedFrom` is unchanged.
- `AppsRuntime.pins.{fork,rebase}` → `AppsRuntime.seed.{from,reseed}`, plus
  `seed.drift`. `seed.from({ component, slot?, instruction? })` and
  `seed.reseed({ appId })` both return the `AppDocument`.
- `pinComponentName` → `seedComponentName`; `PinBaseline`/`pinBaselineSchema` →
  `SeedBaseline`/`seedBaselineSchema`; `AppsConfig.pinBaselines` →
  `seedBaselines`; `detectPinDrift` → `seedDrift` (one seed, so it returns one
  `SeedDrift` or `null`); `ScreenPinDrift` → `ScreenSeedDrift`.
- `EditResult.driftedPins?: PinDrift[]` → `EditResult.seedDrift?: SeedDrift`;
  the tree payload's `pinDrift` array → a single `seedDrift`.
- HTTP: `POST /apps/fork-pin` and `POST /apps/:id/fork-pin` → `POST /apps/seed`;
  `POST /apps/:id/rebase-pin` → `POST /apps/:id/reseed`.
- Client: `apps.forkPin(...)` → `apps.seedFrom({ component, slot?, instruction? })`;
  `apps.rebasePin(id, slot)` → `apps.reseed(id)`.
- Agent tool `vendo_apps_rebase_pin` (appId + slot) → `vendo_apps_reseed` (appId).
- `@vendoai/actions` no longer declares its own `CapturedPinBaseline`; the one
  shape lives on `@vendoai/apps/contract` and actions re-exports it as
  `SeedBaseline` / `seedBaselineSchema`.
- `PinForkInput`, `PinForkResult`, `PinRebaseResult` and `PinDrift` are removed.

Seeding into an app that already exists is gone: the gesture always mints an
app, because a seed is the provenance of a whole app rather than a row added to
one. The generated component name stored inside documents is deliberately
unchanged, so apps already on disk keep working.
