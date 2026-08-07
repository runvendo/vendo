---
"@vendoai/store": patch
---

Three correctness fixes. No public surface changes, no stored shape changes, no migration.

**One rule for a transcript row's id.** `threadMessageRowIds` (TypeScript) and
`replaceThreadMessages`'s `COALESCE(elem->>'id', …)` (SQL, twice) expressed the
same rule in two dialects that disagree: `elem->>'id'` yields `''` for
`{"id":""}` rather than NULL, and `'5'` for `{"id":5}`. The duplicate-id guard
runs on the TypeScript rule, so those inputs cleared it and then collided inside
the INSERT, failing with the bare Postgres 21000 the guard exists to prevent and
losing the whole write. The ids are now derived once and passed in as a
`text[]`; both `COALESCE` expressions are gone.

**`threadStore.delete` takes the transcript with it.** It dropped the thread row
and the harness-state row but never `vendo_thread_messages`, which has no
foreign key. A message row carries no subject of its own, so those rows became
permanently unreachable — `erase.bySubject` reaches them only through
`thread_id IN (SELECT id FROM vendo_threads WHERE subject = $1)`, which is empty
once the thread is gone. It is now the same cascade
`ops.transcripts.deleteThread` already ran, in one transaction, still guarded on
the RETURNING row so a foreign principal's delete sweeps nothing.

**One grant row per (app, principal), on every records adapter.** `appAccess`
minted a fresh `ag_<uuid>` per `grant`; uniqueness came only from
`ON CONFLICT (app_id, principal)` in the local Postgres routing door, which no
hosted or BYO adapter has. A second row made downgrades silently fold back to
the stronger level and left `revoke` deleting only the first match. `grant` now
reuses the existing row's id, and `revoke` deletes every matching row.
