---
"@vendoai/core": minor
"@vendoai/apps": minor
---

`AppMachine.envStaleAt` — the Wave-7 env-rebuild marker — and the wake-time
rebuild it gated are removed.

The marker's only production writer was the secrets-exposure grant flow deleted
in #1100, so nothing could set it any more and `rebuildStaleEnv` could never
run. What goes with it:

- `AppMachine.envStaleAt` (`@vendoai/core`) — field and schema entry
- `rebuildStaleEnv` and both of its wake call sites (`machine-lifecycle.ts`)
- the `injectEnv` slot on `MachineLifecycleConfig`, whose only reader it was,
  and the `injectEnv: pushBoxEnv` wiring in `box-lane.ts`
- `nextEnvStaleAt` (`persistence.ts`), which already had zero callers

The two paths that assemble and inject a box's boundary env are untouched:
provision (`buildEnv` → `SandboxAdapter.create`) and the pre-edit re-injection
every box edit makes (`buildAppEnv` → `pushBoxEnv` over the box control port).
`pushBoxEnv` itself stays — the edit path is its live caller.

The machine schema is `.passthrough()`, so a stored document that still carries
an `envStaleAt` key parses exactly as before; the key survives as an unknown
field and is simply no longer typed, validated, or read.
