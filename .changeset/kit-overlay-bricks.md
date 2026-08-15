---
"@vendoai/apps": minor
"@vendoai/ui": minor
---

Overlay bricks — Modal, Sheet and Toast — plus the Kit's first stylesheet.

The three bricks paint outside the screen's own box, on Base UI's Dialog and
Toast, so the focus trap, Esc and the page's scroll lock come from the library
rather than from hand-rolled listeners. `KitOverlaySpec` names the open/close
pair that makes an overlay an overlay, and `KIT_OVERLAY_SPECS` is how a consumer
routes one without matching on a component name.

The renderer reads that map: an overlay node paints on the body-level host, so
its box in the tree generates nothing, and the Stack it was written in no longer
carries an empty gap where the overlay used to sit.

`KIT_CSS` is the Kit's first document-level stylesheet, and it carries nothing
but pseudo-class state — hover, focus-visible and the press, keyed on `data-kit`.
Everything themable stays inline on the brick. The sheet is injected from the
tree surface itself, so every generated screen has hover and focus states —
not only the ones that happen to raise an overlay.
