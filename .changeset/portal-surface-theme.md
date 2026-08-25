---
"@vendoai/ui": patch
---

The last two portal surfaces inherit the spawning surface's theme.

The knowledge citation hovercard and the mobile approval sheet both portal to
`document.body` but still read the PROVIDER theme, so a surface carrying its own
`theme` — a dark `VendoOverlay` on a light page — popped a light hovercard out
of a dark thread. Both now read the enclosing chrome boundary's resolved theme
through `useChromeTheme()`, the same seam the approval modal, morph toast and
toast stack already use. Outside any boundary they answer the provider's theme
exactly as before.
