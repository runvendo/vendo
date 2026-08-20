---
"@vendoai/ui": patch
---

A remix repaints when its build lands, instead of holding the pre-edit port
until the person presses F5. A remix's screen is written long after its row
exists: the seed paints the ported host component first and rebuilds it into the
person's wish tens of seconds later, and every edit the chat runs does the same
again. `useApp` re-reads only while `open` is still answering pending, so the
surface settled on whichever screen happened to be servable first — the port —
and then never looked again. The agent said "it's replaced the original on your
page" over a card still painting the original.

`<Remixable>` now re-reads on what a build leaves on the app document — the code
it saved and whether it is still saving — off the discovery poll the wrapper
already runs. No request of its own, and no cadence: an app nobody is building
is an app nothing re-reads.
