---
"@vendoai/core": minor
"@vendoai/apps": minor
"@vendoai/store": minor
"@vendoai/vendo": minor
---

**One SQL database per app, and the app-data family is deleted.**

A generated app now keeps its data in a real SQL database of its own, reached
through one agent tool — `vendo_apps_sql`, which runs one statement and whose
description states the live dialect. Two table namespaces are the entire
permission model: `shared.<table>` is one table every user of the app shares,
and `mine.<table>` is per-user. A bare table name is refused with what
happened, why, and the fix.

`mine.` is enforced at the DOOR and never by generated SQL: `mine.x` becomes a
physical table of that person's own, named with a character no identifier the
grammar admits can contain, so one person's tables have no spelling in
another's SQL. Every statement runs with `search_path` set to the app's own
schema, so a name that arrives unqualified resolves inside the app or nowhere.
Ordinary SQL keeps ordinary meaning — a `PRIMARY KEY` is unique per person, a
`UNIQUE` is per person, and a join is a join.

New adapter slot `createVendo({ appDatabase })`, standard adapter rule: an
explicitly passed adapter always wins. Unset, every app gets its own fenced
schema inside the Postgres the host already wired — ZERO new configuration. A
store with no SQL handle composes no adapter and the tool is not offered.

**Deleted, whole:** the `vendo_apps_data_list` / `_put` / `_delete` tools, the
`storage` declaration on `AppDocument` (`StorageDecl`) and its allow-list gate,
`StoreOps["appData"]` and `AppDataTarget`, the `app:<id>:<collection>` record
and blob namespaces, the 256 KB record and 5 MB file caps, and the app-data
owner backfill. Migration is fix-forward: chat-built apps could never save
through the old path, and its blob half had no callers. The `appData.*` wire
paths keep their RETIRED slots so the `/status` op levels still point at the
ops they always pointed at; nothing serves them and they answer 501.

Three isolation hazards die with that path: the unowned façade that gave every
user one shared drawer on a store with no ops surface, `hostedStore`'s
`owner: "user_local"` default that put a whole multi-user deployment in one
drawer, and the un-allowlisted `ops.blobs` namespace that let a caller write
into another owner's app files.
