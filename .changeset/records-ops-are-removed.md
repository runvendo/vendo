---
"@vendoai/core": minor
"@vendoai/store": minor
"@vendoai/vendo": minor
---

**Breaking.** The generic `records.*` store ops are gone. `/records/*` now
answers `not-implemented` (501), naming the op you called. There is no flag,
no fallback and no deprecation window left — this release IS the removal.

**Do this.** Find every `ops.records.*` call and move it to the family that owns
the data:

- Rows and files a generated app invents → `ops.appData.put/get/list/delete` and
  `ops.appData.putFile/getFile/listFiles/deleteFile`. The target carries
  `{ appId, collection, owner }`; the owner is stamped on writes and scopes
  reads, so you no longer prefix a collection name to keep users apart.
- Vendo's own collections (threads, runs, grants, audit, effects, apps,
  automations schedules and deliveries) → `ops.engine.*`. Same seven verbs, same
  arguments, same returns, behind the `ENGINE_COLLECTIONS` allowlist. A name
  outside it is refused with `blocked` and told where its data belongs.

**If you wrote raw HTTP against the store wire,** the seven `/records/*` routes
are the break: `POST /records/put` now returns

```json
{ "error": { "code": "not-implemented", "message": "the store wire no longer serves records.put — …" } }
```

with HTTP 501. `STORE_WIRE_PATHS` holds 35 ops across 8 families, and
`status()` reports `ops: 35`.

**The `StoreAdapter` façade is unchanged and still supported.**
`store.records(collection)` and `store.blobs(namespace)` keep working exactly as
they did — including `claim` and `atomic` feature detection. On `hostedStore`
they are now built on the two surviving families: an `app:<appId>:<name>`
collection or namespace rides `appData`, everything else rides `engine`. Two
consequences on the hosted adapter only:

- A collection outside the engine allowlist (a host's own `"invoices"`) no
  longer has a home on the hosted mount and is refused with `blocked`. Local
  and BYO stores are untouched.
- An app-scoped drawer is owner-scoped now, like every other appData read.
  `hostedStore({ owner })` names the owner; it defaults to the single-player
  `"user_local"`, matching `createStoreOps`' bound workspace owner. **If you
  serve more than one end user through one `hostedStore` instance, set it** —
  on the default, every user's app rows and files land in one owner's drawer
  and read each other. Construct one `hostedStore` per end user, or use
  `ops.appData`, whose every verb names its owner at the call. Because
  `appData` has no compare-and-set verbs, an app-scoped `RecordStore` omits
  `claim` and `atomic` rather than advertising what it cannot serve.
- One error string changed: a bare, envelope-less 404 from a blob read on the
  hosted adapter now says `Vendo Cloud store request failed with 404` instead
  of naming a "bare 404". Same behaviour — it still throws loudly rather than
  reading as a missing blob — but stop grepping for the old wording.

**Also removed, because they only existed to announce the retirement:**
`STORE_WIRE_DEPRECATED_OPS`, `STORE_WIRE_DEPRECATED_REMOVED_IN` and
`STORE_WIRE_MIN_CLIENT_VERSION` (all `@vendoai/core`), the `deprecated` and
`minClientVersion` fields on `StoreWireStatus`, the seven deprecated
`storeWireRecords*RequestSchema` aliases (use `storeWireCollection*RequestSchema`),
and doctor's `E-LIVE-008` warning. The `E-LIVE-008` code stays listed in the
registry and on the verify page — doctor codes are never reused — but nothing
emits it any more. The handshake body still passes unknown keys through, so a
client on this release reads an older mount's `/status` without complaint.
