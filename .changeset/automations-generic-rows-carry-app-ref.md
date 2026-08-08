---
"@vendoai/automations": patch
---

Engine-owned generic rows carry their app ref, so app erase collects them.

The schedule cursor, the webhook signing secret and the delivery ledger were
written with no refs at all. The 02-store §5 app-erase cascade collects generic
rows by `refs @> {app_id}`, so all three outlived the app they belong to — a
live HMAC secret kept authenticating for an app that no longer existed, and
`automations:deliveries`, which has no sweep or TTL anywhere, grew one permanent
row per webhook delivery. Five write sites now carry the ref, including the
tick's compare-and-swap replacement and the pre-rekey cursor migration.

Rows already on disk are unaffected in behavior: every read is by row id, so
nothing that works today stops working. The ref is stamped forward — a live
schedule cursor gains it on its next tick; a webhook secret gains it on its next
mint or rotation.

The package root drops `appIntentOf`, `SPONSORSHIPS` and the `Sponsorship` type.
Nothing outside this package imported them. `triggerKey` stays exported.
