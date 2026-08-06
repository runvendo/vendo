---
"@vendoai/core": minor
"@vendoai/guard": minor
---

The freeze flag: one switch that stops every call.

`guard.freeze(by)` writes a single row — `freeze` in the guard's own
`guard:controls` collection — and `#checkWithMetadata` reads it before anything
else. While it is set, every check comes back
`{ action: "block", decidedBy: "frozen" }`: a declared read, a call a standing
grant authorizes, an approved replay. Nothing is spent on the way — no risk
resolution, no breaker slot, and no parked approval left behind for someone to
answer later. `guard.unfreeze(by)` lifts it and `guard.frozen()` reads it.

It is a ROW and not a config field on purpose: the moment you need a kill switch
is the moment you cannot redeploy to get one. The console flips the same row
directly through the store, and a guard in another process obeys it on its very
next check.

Both directions land on the audit trail as `policy-decision` events naming who
flipped the switch, and every call the freeze refused is audited exactly as any
other block is. `@vendoai/core`'s `GuardDecision` block arm and `AuditEvent`
gain the `"frozen"` provenance (schemas included).
