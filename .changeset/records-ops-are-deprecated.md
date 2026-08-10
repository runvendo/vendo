---
"@vendoai/core": minor
"@vendoai/store": minor
"@vendoai/vendo": minor
---

The generic `records.*` store ops are deprecated. They still work; they will be
removed in `0.13.0`.

**What is happening.** `records.*` was one untyped door onto every row in the
store — a host's data, an app's data and Vendo's own bookkeeping all went through
the same seven verbs, and nothing in the call said which was which. Two named
families replaced it: `appData.*` for the rows and files a generated app invents
(the owner is stamped for you, so one user's data cannot be read by another's app
session), and `engine.*` for Vendo's own collections (the same seven verbs, behind
the `ENGINE_COLLECTIONS` allowlist). Everything `records.*` can do, one of those
two can do with the ownership question answered.

**Nothing breaks in this release.** All seven `records.*` ops stay on the wire and
keep their exact behaviour. This release only *announces* the retirement, in the
two places a caller will actually see it:

- `status()` (`GET /status`) now returns `minClientVersion` and `deprecated` — the
  seven `records.*` op names — beside the existing `format` and `ops: 42`. Clients
  that already parse the handshake get the notice for free; the fields are
  optional on `StoreWireStatus`, so an older client ignores them.
- `vendo doctor` warns `E-LIVE-008` when a mount advertises deprecated ops, naming
  them and the removal release. It is a warning, never a failure — doctor still
  exits 0.

**What you need to do before `0.13.0`.** Find your `records.*` calls and move each
one to the family that owns the data:

- Rows and files belonging to a generated app → `appData.put/get/list/delete` and
  `appData.putFile/getFile/listFiles/deleteFile`. The target carries `appId`,
  `collection` and `owner`; you no longer invent a collection-name prefix to keep
  users apart.
- Vendo's own collections (threads, runs, grants, the audit log, effects, apps,
  automations schedules and deliveries) → `engine.*`, same arguments, same
  returns. A name outside the allowlist is refused with `blocked` and told where
  its data belongs.

If you host your own store mount, `STORE_WIRE_DEPRECATED_OPS` and
`STORE_WIRE_DEPRECATED_REMOVED_IN` (both `@vendoai/core`) are what the handshake
advertises, so your mount can say the same thing without hardcoding the list.
`STORE_WIRE_MIN_CLIENT_VERSION` names the release the mount was built from.

After `0.13.0`, a `records.*` call answers `not-implemented` (501). There is no
flag to keep the old door open.
