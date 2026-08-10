---
"@vendoai/apps": patch
---

A remix survives its own edit door. Three defects, all of which destroy work a
person can see on screen, all of which returned 200.

**The island gate no longer runs over a seeded seat.** Its rules are the
GENERATED-island contract — no imports, ambient Kit only, no hand-typed constant
feeding displayed math — and captured host source cannot satisfy them by
construction (the demo host's own capture blocks on `pad = 6`, SVG chart
padding). `seed.from` writes its row without the floor, so the document was born
un-admittable: the next edit ran the floor, got the unsatisfiable blocks back
verbatim as repair instructions, and the only edit that cleared them was to stop
rendering the island. The person's fork was replaced by plain host components,
the bundle orphaned and the app renamed, while the card still rendered and the
✦ pill still said "Remixed". A capture with no default export is still refused,
by the seed doors themselves, where it always was.

**A fork records the version that says where it came from.** `seed.from` is the
one create that does not go through `persistEdit`, so it now appends its own
history entry. Without it a remix arrived with no history at all — and a
review-kind remix failed closed to pending the moment its current version
stopped being approved, because the reviewer's serve path reads the newest
approved snapshot out of history.

**A file save no longer deletes a legacy remix's source.** The save's
seeded-bundle carry-forward was keyed on `origin === "seeded"`, but a component
entry may be a bare source string — the shape every remix forked before the
seeded bundle existed is stored in — and those read back as `authored`, so the
carry never fired and a save that omitted the component dropped the remix
outright.

All three now key on the component's NAME (`isSeedComponentName`). The origin
cannot carry this: a compiled `app.vendo` prints its components as bare source
strings, so an origin test reads `authored` on exactly the path that matters.
