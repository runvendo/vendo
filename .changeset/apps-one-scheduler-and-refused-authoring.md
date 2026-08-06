---
"@vendoai/apps": major
---

**BREAKING:** the BYO schedule engine is gone — a machine app's `vendo.json`
schedules are document triggers now, fired by the automations engine.

`AppsRuntime.schedules` (its `tick`, `sync` and `report`) and the
`SCHEDULE_STATE_COLLECTION` export are removed. `machine.syncManifest(appId, ctx)`
folds a woken box's declared schedules into the app's document triggers and
`machine.report()` says what happened, so last-fired state lives on the engine's
per-trigger cursor instead of in a second `vendo_app_schedules` cache that a tick
had to read to decide due-ness. A host that called `runtime.schedules.tick()` from
its cron should call the one `/api/vendo/tick` door instead — it already drove the
automation schedules, and it now drives these.

Authoring changed in the same direction: the planner is never offered a tool whose
unattended use is irreversible (the predicate is core's own
`withheldFromUnattended`, the same one the run's projection uses, so authoring and
firing cannot disagree), and an ask that needs one comes back as a sentence naming
why and offering the away-safe half — read the live data, publish the result, and
let the person do the irreversible part themselves. `planAutomation` is exported
so a harness can author a plan without booting the generation pipeline.
