---
"@vendoai/ui": minor
---

Slot: wire the empty-state CTA + pinned-component placement path (ENG-223).
`VendoSlot`'s empty state is now a real, focusable `<button>` (was a
non-interactive div): activating it opens the authoring surface via the new
optional `onAuthor(slotId)` prop, and — when no handler is supplied — opens a
mounted `VendoPalette` through the new `openVendoPalette()` singleton opener
(host-collision-safe like the keybinding; a no-op when no palette is mounted).
`VendoSlot` also gains a `pin` prop for the "or a pinned component" path in
08-ui §4: a pinned `vendo-genui/v1` view (`{ payload, data?, onAction? }`)
now mounts in place through the tree renderer and the PinMount error boundary,
falling back to the host's original children if it throws — previously a slot
could only mount a whole app, so hosts pinning a generated component had to
bypass `VendoSlot` with a bare `AppFrame` (no fallback). The Cadence demo hero
slot is switched to this path.
