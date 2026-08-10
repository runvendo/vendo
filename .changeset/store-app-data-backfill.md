---
"@vendoai/store": minor
---

`backfillAppDataStamps` — the migration that keeps pre-appData data visible.

Every appData read is auto-scoped to the caller's owner: `refs.subject` on rows,
an `<owner>/` leading key leg on their file twins. A row written before a door
moved onto the family carries neither, so the moment that door flips the row
goes **invisible** — not deleted, unreadable, and an auto-scoped query returning
nothing looks exactly like an empty collection. This is the one-shot, re-runnable
migration that stamps that data with the owner it always had.

`backfillAppDataStamps(store, { batch = 500, appId })` reports
`{ apps, rowsStamped, rowsSkipped, filesMoved, orphanCollections }`. The owner is
`vendo_apps.subject` with no personal-vs-promoted branch — a promoted app's
subject IS the org id (§9.5), so the row already holds the right value. Only
rows lacking a stamp are touched, so a second run reports `rowsStamped: 0`;
`data`, `revision` and `updated_at` are left exactly as they were, because the
row's content did not change and a bumped revision would fail a live CAS holder
for a change it cannot see.

**Where an owner cannot be established — or cannot be used safely — nothing is
guessed at.** A collection whose app has no `vendo_apps` row, whose app row
carries an empty subject, or whose subject contains the `/` that separates the
owner leg from the caller's file key, is REPORTED in `orphanCollections` and
left completely untouched. That last one is data, not policy: owner `own_a/sub`
with key `x.bin` and owner `own_a` with key `sub/x.bin` spell the identical
stored key, and no later validation can unbend a key already written. The
function issues no `DELETE` anywhere, and a blob key collision throws rather
than inventing a resolution.

`lifecycle.promote` now moves the whole app in its existing single transaction:
the app's appData is backfilled *before* the row flip (so the stamp it writes is
still the old subject), then every row and file changes hands in one uniform
rename, and the app's bearer token's `refs.subject` follows. Both halves are
required — rows alone would leave a promoted app's box writes stamping the
departed personal subject, and the org blind to its own new data.
