---
"@vendoai/ui": patch
---

The overlay launcher anchors to any viewport corner and takes host offsets. `launcher` accepts `"top-right"` / `"top-left"` alongside the bottom corners, and the object form gains `offset: { x?, y? }` — extra pixels pushed inward from the anchored corner, ridden as CSS variables folded into the existing safe-area calc so every current install stays pixel-identical. The whole launcher cluster moves as one: the first-run whisper and the completion toast follow the pill's corner (sitting below it in top corners) and inherit the same offsets. Drag is deliberately deferred; offsets cover the collision a host can predict, and `useVendoOverlay` still covers the rest.
