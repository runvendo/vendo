---
"@vendoai/apps": minor
---

Four unreachable features leave the public surface. Nothing in this repo, the
console, or the examples called any of them; every name was re-grepped across
`packages/`, `examples/`, `fixtures/`, `corpus/` and `scripts/` before removal.

**The secrets-exposure write path (ENG-345) is gone.** `AppsRuntime.secrets` —
both `exposure()` and `setExposure()` — is deleted, along with the
`vendo_secret_exposure` grant store, the `SecretExposureState` and
`SetExposureResult` types, and the synthetic `vendo_secret_expose` approval
descriptor. This was the exception path that placed a secret's REAL value into a
box. The default is unchanged and is now the only behavior: a declared secret
enters the sandbox as an opaque alias and is substituted at the egress proxy.
The egress half of the approval flow (`vendo_egress_allow`) rides the same
`onApprovalDecision` subscription and is untouched, as are `redaction.ts` and
`egress-approval.ts`. `buildEnv` keeps its optional `grants` argument, so a host
that assembles box env itself needs no change.

**Five manual machine-lifecycle doors are gone**: `machine.provision`, `wake`,
`sleep`, `destroy` and `syncManifest`. Each duplicated work the runtime already
does on its own — graduation provisions, box edits and fn calls wake, edits
sleep, `apps.delete` reaps, and manifest schedules fold in automatically after
every box edit. `machine.available`, `machine.ping` and `machine.report` stay,
and the whole internal lifecycle is unchanged.

**Two bypassed trust-check doors are gone**: `inClient.verdict` and
`inClient.approvals`. The verdict clients actually read rides the `open()`
payload as `inClient`; `inClient.shipDiff`, `inClient.approve`, the dev approve
route and all internal verdict logic are unchanged.

**`pins.drift` is gone.** The live drift path is the report `open()` attaches to
the payload, which is unchanged; `detectPinDrift` and its internal callers stay,
as do `pins.fork` and `pins.rebase`.
