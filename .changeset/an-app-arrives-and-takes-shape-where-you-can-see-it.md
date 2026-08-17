---
"@vendoai/apps": minor
"@vendoai/core": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

An app now arrives somewhere a person can see it, and takes shape while they
watch. Generated apps used to appear by surprise and load behind a generic
shimmer: nothing said an app was new, a build in flight was a spinner with no
information in it, and a pinned app had no handle at all.

Arrival is a per-person flag, server-side. `AppsRuntime.seen(appId, ctx)` is the
idempotent mark, `AppsRuntime.list` now answers `AppListRow[]` — the document
plus an `unseen?: boolean` this caller's read alone can say — and the rows
carry it through `VendoClient.apps.list()` to `useAttention().unseenApps`, which
lights the launcher's quiet dot. Precedence is unchanged: a waiting decision
still shows the numbered badge instead, and `unseenResults` now means a finished
run OR an app nobody has looked at (the pill's spoken line names neither half).
Rendering marks it, and only rendering to a PERSON does: `GET /apps/:id/open`
records it, while the same runtime door an MCP client or an automation reaches
through does not, so an agent reading a tree never clears somebody's dot. Rows
live in `vendo_app_seen`, which puts the engine allowlist at
`ENGINE_ALLOWLIST_VERSION` 3, and they are swept when the app is deleted.

A build in flight is now visible instead of merely slow. `AppsRuntime.open`
takes `{ pending?: true }` and answers `PendingSurface` with an optional `tree`
— the forming payload's GEOMETRY, node ids and nesting and no data values — so
the embed's existing 1.2s poll paints stepped assembly off the same request
rather than a bar, and never shows a number it will take back. Unfinished
sections render wet (dim, desaturated) and dry to full ink as they land, once,
with the hairline ring following the last one. Slots remember the shape of the
app they held and wait in its silhouette rather than a shimmer, and a placed app
carries the ✦ handle: Edit in chat (`OpenConversationOptions.appId` features the
app on the stage and prefills the composer), Refresh, Unpin. The pin flight
lands flush and its confirmation ring now waits for the placement write
(`PinCeremonyOptions.confirmed`) instead of an animation timer.
