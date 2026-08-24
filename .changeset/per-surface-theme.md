---
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

Per-surface `theme` overrides on the chrome surfaces.

`VendoOverlay`, `VendoSlot`, `VendoTrigger`, `VendoAppEmbed`,
`VendoApprovalEmbed`, and `VendoToolResult` each take an optional
`theme?: Partial<VendoTheme>`, merged group by group over the provider's
resolved theme (over the default with no provider) — so one surface can be a
dark panel on a light page without a second provider. What a surface portals to
`document.body` goes with it: the overlay panel, the approval modal a press
parks on, and the toast stack all wear the spawning surface's theme instead of
falling back to the provider's.

Frame only — a generated view mounted inside a themed surface keeps the
PROVIDER theme, whether it is served in an iframe or rendered natively as a pin.

`VendoTheme` is now nameable from `@vendoai/ui` and `@vendoai/vendo/react`.
