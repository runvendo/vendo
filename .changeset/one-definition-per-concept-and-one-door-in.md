---
"@vendoai/apps": minor
"@vendoai/mcp": minor
"@vendoai/automations": minor
"@vendoai/store": minor
"@vendoai/core": minor
---

One definition per concept, and one door in

Every app write that mints or changes a document now passes the same admission
gate, and the concepts that were declared in five places are declared once.

**The one door.** `admitAppDocument({document, origin})` ships from
`@vendoai/apps/contract` — pure, browser-safe, structural schema plus the
cross-field rules, with `validateAppDocument` still exported as its inner half.
`origin` is recorded on the refusal and never changes what is checked. It is
called from exactly one place: the row writer in `server/persistence`.

**The door sanitises as well as validates.** The venue verdict (`inClient`),
the drift report (`pinDrift`), the `dataUnavailable` claim and CDN furnishing
packages are server-authoritative: only code that verified the hash, compared
the baseline or ran the queries may assert them. They were stripped on the way
OUT, which kept a forged claim off the wire but left it in the row — three
write paths each remembered to strip first and `importApp` did not. The row
writer strips them now, so a reader that forgets can no longer be wrong.
**Pre-existing, fixed here rather than introduced here.**

**One named exception, stated out loud:** `@vendoai/automations`' `writeApp`
puts the row directly. Its two callers flip `enabled` on a document they
round-tripped unchanged out of the store, and forcing them through admission
would let a document stored before this door existed refuse a *disarm* — a
safety control must not fail by refusing to turn something off.

**Breaking**

- `@vendoai/mcp` no longer exports `AppsPort`. It was a structural mirror of
  `AppsRuntime`; the door types its apps ride-along off the real runtime, so
  the two can no longer disagree. Hosts that named the type should use
  `NonNullable<McpDoorConfig["apps"]>`. Note that the mirror typed `call` as
  `Promise<unknown>` while the umbrella has always wired `AppsRuntime.call`,
  which returns a `ToolOutcome` — the real shape is now visible in the types.
- `appRecordInput`, `updateAppRow` and `persistEdit` (all internal to
  `@vendoai/apps`) take a required `AdmissionOrigin`. Required, not defaulted:
  a default would let a write path record itself anonymously.
- `@vendoai/automations` renames its row type `AppRow` → `AppData` and drops its
  local `appRowSchema`, both of which now come from `@vendoai/apps/contract`.

**Retired from the plan: the `vendo_make` envelope unification.**

The MCP door was to answer `vendo_make` with the same `vendo/app-ref@1`
envelope the in-process tool pack returns. It is not shipped, for two reasons:

1. It breaks a tested door-parity law — the in-process leg and the door leg
   must return the same output, and the envelope made them disagree.
2. It would make the door state something false. The envelope's `status` is
   pinned to the literal `"building"` and documented as *"never means done,
   win or lose"*, because it exists for the fast-return path where the build
   is still streaming. The MCP door does not stream; it runs `vendo_make` to
   completion. Wrapping a finished build in it tells an agent the app is not
   built when it is.

The receipt is the honest answer on a door that runs to completion. Reviving
this needs a non-`"building"` status and a deliberately rewritten parity law,
as its own change.

**Unifications**

- `AppRow` / `AppData` / `appRowSchema` — the stored row, declared once in
  `@vendoai/apps/contract`. It was five: the store's projection, the automations
  engine's read shape, the persistence layer's `AppRowData`, a structural alias
  in `write-surface.ts`, and a narrower mirror in the umbrella's sync reader.
- `data-vendo-view` — one producer, `vendoViewPart` in `@vendoai/core`. Four
  writers hand-built the part and only two validated it.
- `WIRE_RESHAPE_OPS` is now derived from `RESHAPE_OPS` minus the aggregates
  rather than listed a second time, so the two cannot drift.
- `stripServerAuthoritativeFields` moves to `@vendoai/apps/contract` (it is pure
  and browser-safe) and is re-exported from the package root, so the console can
  stop hand-copying it.
- `AppData` is declared beside `AppRow` in the contract, replacing the console's
  mirror of a type `@vendoai/store` never exported.
- The corpus structural layer's expected-files list gains `.vendo/catalog.json`
  and `.vendo/theme.extracted.json`, both of which every real `vendo init`
  writes; its duplicated tool-identity join collapses to one copy.
