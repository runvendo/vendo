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

`KIT_CSS` is the Kit's first document-level stylesheet, and it carries nothing
but pseudo-class state — hover, focus-visible and the press, keyed on `data-kit`.
Everything themable stays inline, because inline is what survives the jail; the
sheet is injected into both documents that paint the Kit, the host page's and
the island's own.
