---
"@vendoai/core": minor
"@vendoai/guard": minor
"@vendoai/apps": minor
"@vendoai/vendo": minor
"@vendoai/ui": minor
"@vendoai/agents": minor
"@vendoai/agent": minor
---

One brain, one scheduler, and consent that is per trigger — everywhere outside
`@vendoai/automations` that has to agree with it.

A fire-time call now carries WHICH trigger fired (`TriggerRef.id`) and WHICH
firing it belongs to (`TriggerRef.lineageId`), so the guard matches an away grant
on (app, trigger) instead of app-wide — arming one trigger no longer authorizes
its siblings — and keys effect receipts on the firing, so re-running a run that
failed loudly cannot repeat the work the first attempt already completed. An
agentic firing runs through the same away runner the rest of Vendo uses, seeing
only the connector dispatcher it was actually granted. A machine app's
`vendo.json` schedules are folded into its document triggers when the manifest
syncs, so there is exactly one scheduler in the deployment (the automations
engine) and one tick that drives it; `AppsRuntime.schedules` and its
`SCHEDULE_STATE_COLLECTION` cache are gone, with `machine.syncManifest` and
`machine.report` in their place. Authoring refuses what it cannot take back: the
planner is never offered a tool whose unattended use is irreversible, and an ask
that needs one comes back as a sentence naming why and offering the away-safe
half of the same request. The panel and the wire follow: per-trigger enable,
disable, dry-run and adopt doors, a `POST /runs/:runId/rerun` door, and a run
that stopped for a missing permission showing "Failed" with the consent card and
Grant & re-run right on the row.
