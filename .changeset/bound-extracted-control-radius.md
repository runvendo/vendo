---
"@vendoai/vendo": patch
---

Bound the control radius that `vendo init` extracts from a host's CSS. A stock `create-next-app` declares `border-radius: 128px` on a pill button; read literally that became `radius: { small: 64px, medium: 128px, large: 192px }` in `.vendo/theme.json`, every Vendo surface rendered as an ellipse, and the chat panel's composer row fell outside its own rounded box so clicking Send dismissed the overlay instead of sending. The value is now bounded at both choke points every radius passes through — the exact `--radius` read and `validateSlotValue` — rather than rejected, so a genuinely round brand stays as round as a control can be.
