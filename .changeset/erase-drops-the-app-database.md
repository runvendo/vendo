---
"@vendoai/store": patch
"@vendoai/vendo": patch
---

**The erase cascade takes an app's SQL database again.**

`eraseStore().bySubject()` and `.byApp()` deleted `vendo_*` rows and never
touched the app's own SQL database, so a deletion request was answered with a
receipt while every row stayed readable — a regression against the old app-data
path, which erased an app's records and blobs in both cascades.

Both cascades carry the leg again: an app goes with its whole database
(`shared.` and every person's `mine.`), and erasing a person takes their `mine.`
tables inside every app they merely used — an org app outlives the member who
leaves it, so everybody else's rows and the app itself stay. `eraseStore` and
`createStoreOps` take the app-database door as `appSql`, threaded from
composition over the SAME adapter the rest of the deployment runs on. It is
never defaulted, for the reason `files` is not: a host on a Cloud app database
whose erase quietly ran against the local Postgres would get rows deleted and
every app table left behind.
