---
"@vendoai/apps": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

The "Add to…" picker's destinations come from a per-user slot registry on the
server instead of `localStorage`. A slot id is host markup, so nothing knows a
slot exists until a page renders one — but the surface that offers it as a
destination is usually a different page, and often a different device, which
`localStorage` could never reach.

A mounted `VendoSlot` now reports itself through `POST /slots` (batched: a whole
page of slots is one request, and a client repeats a slot at most once a day, so
one long-lived tab renews its slots instead of watching them age out), and
`GET /slots` answers the
caller's own slots, most recently seen first. Rows age out
30 days after the last render that reported them, so a slot deleted from the
codebase stops being offered on its own. The rows live in the generic records
collection (`vendo_slots`), so there is no migration to run, and `refs.subject`
puts them in the existing erase cascade.

> **BREAKING:** `knownSlots`, `noteSlot` and the `SlotNote` type are removed
> from the `@vendoai/ui` and `@vendoai/vendo/react` roots, and `useKnownSlots`
> is removed from `@vendoai/ui/chrome`. Read the registry with the new
> `useSlots()` hook (or `client.slots.list()`); a mounted `VendoSlot` still does
> the reporting for you, so nothing needs to call the write path by hand.
