---
"@vendoai/ui": minor
"@vendoai/mcp": minor
---

Placement reads the slot registry, and `pinSlot` is gone. Naming the pin's
destination on the provider was a second copy of a fact the registry already
held: a mounted `<VendoSlot>` reports itself, and `useSlots()` has always been
able to say which destinations exist. The prop is deleted outright — no shim,
nothing replaces it, and no slot list moves onto the provider.

One affordance now carries the whole rule, and every surface holding a finished
app renders it — the in-thread card, the BYO embed card, and the workspace
stage. With one slot known it is a one-click **Pin to dashboard** doing the real
`apps.place` write, with the ghost flight and the settle ring exactly as before.
With several it is the **Add to…** picker. With none it is nothing at all,
unless the host wired `onPin`: that DIY hook is untouched and is still the whole
pin on a page with nowhere to put a view.

`usePinAction(slot?)` takes the destination instead of reading a prop, and
`PlacementAction` joins the `@vendoai/ui/chrome` surface beside `AddToPicker`
(the thread is an eject template, so what it renders is public by construction).
The MCP Apps shim is regenerated off the same sources.
