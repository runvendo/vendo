---
"@vendoai/agents": patch
"@vendoai/core": minor
"@vendoai/apps": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

A remix follows the page it was forked from. The `<Remixable>` wrapper now
couriers its wrapped instance's live serializable props to the server — on mount
and again on every change — and the ported screen is painted on them.

Until now it was painted on the baseline's `sampleProps`, captured the day
`vendo sync` ran. Maple's remixed net-worth card read `$54,907.15` — the
hardcoded declared example in the host's own registry — while the host's card two
inches away read `$142,929.30`, with a visibly different chart series. A port
renders FROM its props and a query resolves before the render, so nothing in the
screen's source could ever have carried them; the capture was the only value the
floor had.

`AppSeed.props` records them, `POST /apps/:id/props` (`apps.seed.props`,
`client.apps.courierProps`) is the door, and the checks floor's props resolver
prefers them over the capture — which remains the fallback for a remix whose
wrapper has not couriered yet. Writing props is provenance about the call site,
not a content edit: it mints no version and replays no wish, so it is safe on
every render the props really change on.

The boundary is the captured baseline's own declared prop names, applied at the
door, so a prop the host component never declared is dropped before it is stored.
JSON-serializable values only, as before.

Also removes the client-side splice this replaces. It searched the payload for a
node named `seedComponentName(slot)` with `source: "generated"`; a remix is a
ported SCREEN whose tree is whatever rendering produced — nodes marked
`source: "ported"` — and that name only ever names a seat in
`document.components`. The find never matched and the merge never ran, which is
why the numbers were stale in the first place.
