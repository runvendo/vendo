---
"@vendoai/ui": patch
---

`@vendoai/ui/kit` now exports the embedded-surface runtime and the theme
helpers a Vendo app needs inside its own box: `startFrameProtocol`,
`applyThemeVars`, `postToHost`, and `themeCssVariables` / `resolveTheme` /
`defaultVendoTheme`.

The inner half of the frame resize protocol moves out of the jail runtime into
`embedded-runtime.ts` so the jail and a box-served app share ONE implementation
rather than two hand-maintained copies. Behaviour is unchanged, including the
measured viewport-block normalization that keeps a `100vh` child from ratcheting
an auto-sized frame to its cap.
