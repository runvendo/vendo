---
"@vendoai/core": minor
"@vendoai/store": minor
"@vendoai/apps": minor
"@vendoai/ui": minor
"@vendoai/mcp": minor
"@vendoai/vendo": minor
---

A conversation's harness state lives on the conversation, and `vendo_state` is gone

The bookmark a session-owning harness resumes on — `claudeCode()`'s native session
ref — rode `vendo_state` under a synthetic `app_id` of `harness_state:<threadId>`.
That bought "no new table" and paid for it everywhere else: thread deletion swept
the slot by hand in two places, a retention sweep needed a fence to stop the
app-state door from seeing a tenant it could not address, the erase cascade reached
it only through a second selector, and a routed door had to police an id grammar
whose whole job was keeping the two tenants off each other's rows.

It is one nullable `harness_state jsonb` column on `vendo_threads` now. ONE slot per
thread, on the row that already names the thread's owner — so every one of those
hand-wired cascades is just the row going away. The two `DELETE` statements, the
retention fence, the tenant carve-out and its `<appId>:<subject>` grammar, the
`validateId` hook nothing else used, and `harnessStateKey` are all deleted rather
than adapted.

`vendo_state`'s other tenant — an app's per-user state — is deleted with it. Nothing
had written it since the `appData` family took over: `getState`/`setState` on
`AppDataAccess` had no production caller at all, and the `$state` persistence bridge
in `@vendoai/ui` (`onStateChange`) was never wired to anything. The `$state` screen
dialect itself is untouched and still resolves in-session; only the never-connected
persistence half is gone. The reserved-name guards that refuse a storage collection
or a query named `state` stay exactly as they were.

**Breaking — `StoreOps.harness` and the `/harness/*` wire.** The slot is keyed by the
thread it belongs to, and now says so: `harness.get/set/clear(threadId, subject)`,
with wire bodies `{threadId, subject}` on `/harness/get`, `/harness/set`,
`/harness/clear` and on the `harness` part of `turn.load` and `turn.commit`.
`subject` is the thread's OWNER and is authority rather than decoration — a foreign
subject reads an empty slot and writes nothing, and `set` on a thread that does not
exist is refused instead of minting a bookmark no erase could reach. A skewed client
and mount fail CLOSED in both directions: `threadId` is required, so neither side can
read the other's body as a slot it may serve, and each answers an enveloped
`validation`. `/status`'s `ops` level is deliberately not touched — it is a monotone
count that only grows as ops are added, and this adds and removes none.

An app-scoped erase no longer clears harness state. That guarantee is dropped on
purpose: a bookmark belongs to a conversation, and uninstalling an app ends no
conversation. Thread deletion and subject erasure both still take it, and each is
proven end to end against the real store.

**Store schema v11 → v12.** `vendo_threads` gains `harness_state jsonb`. The
migration copies every `harness_state:<threadId>` row onto its thread, matching on
both legs of the old primary key — the id's thread suffix and the subject — then
`DROP TABLE vendo_state`. A row whose subject disagreed with its thread's owner was
unreachable by every read path and by the erase cascade already, so it dies with the
table rather than being promoted onto a row it never belonged to. Guarded on the
table's existence rather than on the version, in the v6 idiom, so it is idempotent
and a no-op on a database created fresh. The v2 backfill is deleted along with it:
it relocated legacy rows INTO this table, and there is nowhere left to put them.

The engine allowlist goes to v11, having lost `vendo_state`.
