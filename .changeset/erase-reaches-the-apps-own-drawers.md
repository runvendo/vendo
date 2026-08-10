---
"@vendoai/apps": patch
"@vendoai/store": patch
---

The byApp erase cascade reaches two app drawers it never could.

Two classes of row survived the app they belonged to, permanently, and both
were invisible for the same reason: the cascade's selectors and the writers'
row shapes were decided in different files and never compared.

**The ref key.** In-client approvals (`vendo_inclient_approvals`) and remix
rejections (`vendo_remix_rejections`) wrote their app reference as
`refs.appId`. The cascade's byApp leg matches `refs @> {"app_id": …}` — the
spelling every other writer in the repo uses (app tokens, placements, app data,
armed automations, sponsorships, grants). Camel-cased, the containment check
simply never matched, so an approval to mount an app in the host page outlived
the app it approved. Both writers now spell `app_id`, and
`backfillAppRefKey(store)` renames the key on rows already on disk: it touches
`refs` and nothing else, deletes nothing, and is re-runnable by construction —
a second run reports `rowsRenamed: 0`.

**The version log.** `vendo:app-history:<id>` holds every stored version of an
app plus its pin-intent trail. The byApp cascade reached generic rows two ways —
an `app:<id>:` collection prefix, or refs containment — and app history
satisfies neither: its name uses a different prefix, and its rows carry no refs
at all. Every version of every deleted app was still in the table. The cascade
now names the collection directly, through core's `engineAppHistory` builder —
the same one the write side composes it with, so the two cannot drift — and it
sits in the shared app-scoped step, so the bySubject leg sweeps it too.

`createInClientApprovals` and `createAppHistory` are now exported from
`@vendoai/apps`, so `@vendoai/store` can prove the cascade against the real
writers rather than a hand-rolled copy of the rows they produce.
