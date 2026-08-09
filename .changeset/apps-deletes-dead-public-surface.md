---
"@vendoai/apps": minor
---

The package now exports only what its consumers actually import. Two runtime
doors and twelve names left the public surface; nothing in this repo, the
console, or the examples called any of them.

Gone from `AppsRuntime`: `machine.editApp` (and its `MachineEditResult` result
type) and `prewarm`. `machine.editApp` had zero callers — the in-box edit path
every caller actually uses is `edit`, which graduates the app and lands the
tree's `fn:` bindings as well as the server change. `prewarm` was a best-effort
page-open model warm-up no surface ever mounted.

Gone from the package root: `placementStore`, `PLACEMENTS_COLLECTION`,
`parseVendoManifest`, `vendoManifestSchema`, `detectPinDrift`,
`inClientApprovalSchema`, `remixRejectionSchema`, `appMountFor`,
`invalidSourcePath`, and `buildFailureReason`. Every one of them is still used
inside the package — only the re-export is gone. The types beside them stay
exported, as do `checkoutApp`, `commitApp`, `appVersionHash`,
`pinComponentName`, `pinBaselineSchema`, `planAutomation`, and
`skeletonFromPlan`, which real consumers import.

`@vendoai/apps/claude-turn` no longer exports the `ClaudeSessionInput` and
`SdkModule` interfaces; `createClaudeSession` and `ClaudeSession` are unchanged.
