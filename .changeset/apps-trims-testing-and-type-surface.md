---
"@vendoai/apps": minor
---

The published surface shrinks to what consumers actually import.

**`@vendoai/apps/testing` exports three names**, down from 32:
`inMemoryBoxFiles`, `scriptedLanguageModel` and `ScriptedModelCall` — the ones
imported outside this package. The other 29 fixtures (the sandbox fakes, the
guard and store doubles, the assemblers, the row seeds) are this package's own;
they still exist, and this package's tests now name the module they come from
instead of the published barrel.

**Eleven free-floating type exports leave the package root.** Each was reachable
from no public value, schema, `AppsRuntime` method or `AppsConfig` field, and
had no importer anywhere: `ManifestTriggerResult`, `ManifestTriggerSync`,
`VendoManifest`, `VendoManifestSchedule`, `PlacementRow`, `PlacementStore`,
`GeneratedAppDocument`, `CheckingLayer`, and the `Check`, `CheckInput` and
`Finding` re-exports — those three are `@vendoai/core`'s types, and a host
writing an `AppsConfig.checks` entry imports them from core, where a pack is
authorable without depending on this block.

Everything anchored to surviving surface stays exported, including
`AuthoredAppResult`, `EditFailure`, `BuildEnvContext`, `BuiltBoxEnv`,
`InferenceResolver`, `AppMachineStatus`, `PublishRecord`, `ShareSnapshot`,
`ReviewStanding`, `RemixRejection`, `ReviewQueueEntry`, `ShipDiffPin`,
`ShipDiffGenerated`, `Skeleton`, `AutomationPlan`, `GenerationDependencies`,
`PlacementEntry`, `PinForkInput` and `PinForkResult`.
