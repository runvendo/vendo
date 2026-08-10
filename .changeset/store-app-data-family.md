---
"@vendoai/core": minor
"@vendoai/store": minor
"@vendoai/vendo": minor
---

`appData` — the store family for everything generated apps invent.

The `StoreOps` contract grows from 27 ops across 7 families to 35 across 8. The
new family is `appData`, and it exists because generic `records.*` made every
app's data one flat namespace with no answer to "whose row is this".

**Every appData row is owner-stamped, by the runtime.** `appData.put` writes
`refs.subject = <caller>` from the host's login session. Generated code has no
field for the owner and cannot invent one: a caller that supplies `refs.subject`
itself is refused with `validation`, never silently overwritten. Unstamped rows
cannot exist.

**Reads are auto-scoped, so permission IS the query.** `list` ANDs the stamp
into `query.refs`, `get` returns `null` for another owner's row, and `delete`
no-ops on one — one owner-predicated statement, so there is no window in which a
foreign row can be raced out from under a check. A `put` against an id another
owner holds is refused with `conflict` rather than overwriting and re-stamping
it. Caller refs still filter alongside the stamp. There is no rules language and
no policy DSL to get wrong.

The stamp is `refs.subject`, deliberately not a new column: the erase cascade
already deletes stamped rows and the GIN index on `refs` already serves scoped
reads, so this ships with **no schema change**. `@vendoai/store` gains one
composer, `app-data-rows.ts`, as the single place that spells
`app:<appId>:<collection>` and the `<owner>/` file-key prefix.

**File twins take a required owner.** `putFile`/`getFile`/`listFiles`/
`deleteFile` live in the app's existing blob namespace under an `<owner>/` key
prefix, which `listFiles` strips on the way out. One new erase selector sweeps
those keys on the subject axis, so a member's files inside a *promoted* org app
— an app the org owns, which the subject cascade never reached — now die with
the member.

All eight verbs speak `vendo/store-wire@1` at `/app-data/*` with exported
request schemas, and are implemented by the local Postgres backend, the Cloud
client, and the in-core memory reference. Eleven conformance cases pin the
behavior in one place and every backend runs them. `StoreWireStatus` also gains
an optional `deprecated` list so a mount can announce ops it is retiring.

`StoreAdapter` — the BYO seam — is untouched.
