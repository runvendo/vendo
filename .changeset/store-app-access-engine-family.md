---
"@vendoai/store": patch
---

the app-access door rides the `engine` family

`appAccess` resolved and wrote app permissions through `store.records(collection)`
— the generic door a HOST reaches its own rows through — so nothing in those
calls said that `vendo_apps` and `vendo_app_grants` are Vendo's own drawers, and
nothing could refuse a call that reached outside them. All four sites now name
their collection to `ops.engine.*`: the app row every level resolves from, and
the grant list, grant write and revoke behind it.

Same collections, same verbs, same arguments, same order. `engine` reaches the
very same routed doors `records` did, so the `ON CONFLICT (app_id, principal)`
floor and the rest of the per-collection policy are untouched; the one statement
added in front is the allowlist.

No new parameter: this helper lives inside `@vendoai/store` and takes the store
itself, so it uses the store's OWN `ops` when it carries one — the hosted store
does, one hop shorter than its `records` façade, which is built on these very
ops — and the family over the adapter's record doors (`engineOverAdapter`) when
it does not, which is what a local store and every BYO adapter get.
