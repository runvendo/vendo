---
"@vendoai/apps": minor
"@vendoai/vendo": minor
---

The slot registry is page-reported and nothing else. `createVendo({ slots })` is
gone, and with it the merge that put a host's declared entries in front of the
reports: a declared slot never decayed and beat a page report of the same id, so
a declaration the product had outgrown was a silent black hole — the pin landed
where no page displays it, and nothing ages that out. A slot is now known
because a `<VendoSlot>` rendered, per user, refreshed on every render and aged
out on its own after `SLOT_DECAY_MS`, so the list is always the places that
really exist.

Nothing declared config could say is lost. The one capability it carried beyond
an id is `description` — the sentence an agent reads to pick between two slots a
label alone cannot separate — and that already lives on the component:
`<VendoSlot description="…">` reports it over the wire, through the registry, to
the model.
