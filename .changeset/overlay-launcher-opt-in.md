---
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

`<VendoOverlay>`'s `launcher` prop now defaults to `"none"`. A bare
`<VendoOverlay />` renders no launcher pill; the panel opens only when something
asks it to — `open`/`onOpenChange`, `useVendoOverlay`, `VendoTrigger`, the
command palette, or a slot. Showing the pill is an opt-in, so nothing Vendo
renders lands on a host's page unasked.

To keep the pill, pass `launcher={{}}`. Every other form of the prop is
unchanged: a corner string still places it, the object form still carries
`position`, `label`, `icon`, and `offset`, and an explicit `"none"` still means
what it always did.

The launcher cluster travels with the pill, so a host that does not opt in also
stops getting the first-run whisper caption and the run-completion toast — both
are anchored to the pill. The panel's own conversation is untouched.
