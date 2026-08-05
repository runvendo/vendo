---
"@vendoai/core": minor
"@vendoai/harnesses": minor
"@vendoai/apps": minor
"@vendoai/guard": minor
"@vendoai/store": minor
---

A turn, a beat and a screen each say what they are — plus an app's code moves
into its row.

**`Turn.turnId`, and every audit row carries it.** There was no turn id anywhere,
so an audit row, a mirrored tool call and a painted view could not be joined to
the exchange they came out of. "Which calls belonged to the turn where the user
asked for X" was unanswerable from the audit plane — the plane billing and
reconciliation read. `mintTurnId()` mints `"trn_<32 hex>"`, the runtime stamps it
where it already builds the `Turn`, and it rides the `RunContext` from that line
on, so every guarded call, audit row and painted view downstream is joinable
without a new parameter on fifteen signatures. Opaque to adapters. Additive for
hosts: `RunContext.turnId` and `AuditEvent.turnId` are optional, and absent means
"no turn", never "unknown turn".

**Beats.** `HarnessEvent`'s `status` member gains an optional `phase`
(`"understanding" | "planning" | "assembling" | "building" | "checking" |
"finishing"` — closed at six) and an optional `appId`. The union itself stays
closed at four members, because adding one is a breaking change for every host
renderer and widening one is not. A harness that yields only `label` puts the
identical transient `data-vendo-status` chunk on the wire it always did.

**`ScreenDescription`.** The view channel carried `UIPayload` —
`{ formatVersion: string; [key: string]: unknown }` — an open bag whose seven real
fields were read by inline cast at each consumer, so a deployed host frontend had
nothing to hold us to. The fields are now declared and versioned, and the render
seam GATES on them: what it compiles must parse or nothing paints, which is the
law that seam already lived by for content that does not compile. The schema
refuses `data` outright — a description says what to fetch, never what came back
— so that law is enforceable rather than written down.

**`AppDocument.source`.** An app's code had three homes: island TSX in
`components`, the wire surface in workspace file rows, and — for a served app —
only inside the sandbox snapshot behind `machine.snapshotRef`. Lose the snapshot
and the customer's app was gone, because the store never had it. `source` maps
POSIX-relative paths to `AppSourceFile { hash, bytes, text?, blobRef? }`, inline
up to `WORKSPACE_INLINE_MAX_BYTES` (which moves to `@vendoai/core`, where its two
readers can both see one answer) and blob-spilled past it through the SAME
`FilesAdapter` the workspace rows already spill to. `machine.snapshotRef` becomes
a cache: an app can always be rebuilt from its row.

`checkoutApp` / `commitApp` in `@vendoai/apps` make a workspace a working copy of
that row — checkout projects the document onto a filesystem, commit diffs the
changed paths back. The two hot paths (`app.vendo`, `plan.vendo`) stay the render
seam's, `trigger` travels untouched through every path, and a source key that
would escape the app's directory is refused by the document validator.

All additive for hosts: every new field is optional, every schema stays
`.passthrough()`, and rows written before this keep parsing unchanged.
