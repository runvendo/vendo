---
"@vendoai/apps": minor
"@vendoai/core": minor
"@vendoai/vendo": minor
---

Retire the server lane and the machine stack it keystoned. Generation's
`generation/lanes.ts` and the escalation box lane are gone, and with them the six
modules they held up — the in-box agent (`box-agent`), egress approval, the `fn`
runtime, the machine lifecycle, and the `vendo.json` manifest fold-in and its
triggers — plus the box-lane secret redaction. `AppsConfig.machine`, `BoxRequest`
and `BoxResponse` leave the runtime config, the served-app arms leave `open`,
`write-surface`, `apps-surface`, `edit-journal` and `app-validation`, the create
door's machine escalate path leaves `build-surface`, and the egress half leaves
`approval-flow`. In core the app document's `ui` enum narrows to `"tree" |
"bundle"`, `machine` / `AppMachine` / `appMachineSchema` are gone, and the
`vendo_egress_approval` row leaves the engine allowlist (v10). The composition
loses the whole machine lane: the box inference door, the implicit egress domains
and the `VENDO_BOX_EDIT_TIMEOUT_MS` / `VENDO_BOX_EDIT_POLL_MS` knobs that only fed
it.
