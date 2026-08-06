---
"@vendoai/apps": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

Placement is a row, not a string on the app document.

"Show this app in that slot" moves off `doc.placements` and into real rows in
the generic records collection (`vendo_placements`, keyed by subject + slot).
That buys three things a document scan could not: a slot can show a build that
has not landed yet, a slot resolves in one query instead of listing every app
the person owns, and one app per slot is enforced by the write instead of by
whoever read last.

- `apps.place({ app, slot })` / `apps.unplace(…)` / `apps.placements({ slots })`
  on the runtime, `POST /apps/:id/place`, `POST /apps/:id/unplace` and
  `GET /apps/placements?slots=…` on the wire, `client.apps.place/unplace/
  placements` on the client.
- `apps.create({ slot })` claims the slot the moment the app id is minted, so
  the slot shows the build forming — and its failure if it never lands.
- `useSlotApp(slot)` now answers `{ appId, status }`, over ONE poller per client
  shared by every mounted slot (it no longer takes `pollMs`).
- Pinning is Vendo's write now: with `pinSlot` set, the pin affordance calls
  `apps.place` itself. `onPin` remains as an optional side-effect seam, so a
  host no longer needs a pin route of its own (Maple's is deleted).
