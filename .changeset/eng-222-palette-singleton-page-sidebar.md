---
"@vendoai/ui": minor
---

Palette + Page fixes (ENG-222). `VendoPalette`'s keybinding is now a
host-collision-safe singleton: one shared listener no matter how many palettes
mount (no more double-toggle across mounts), a configurable `hotkey` prop
(a chord like `{ key: "k", meta: true }`, a custom matcher function, or `false`
to disable the keyboard opener entirely), and it no longer steals a keystroke
from a focused host input while closed. `VendoThread` gains an optional
`onThreadId` callback that fires with the effective (possibly server-minted)
thread id. `VendoPage`'s chat sidebar now refreshes when a conversation started
via "New conversation" mints its thread, so the new conversation appears (and
highlights) instead of never showing; an explicit selection also survives a
background list refresh.
