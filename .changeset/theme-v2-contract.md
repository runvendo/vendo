---
"@vendoai/apps": minor
"@vendoai/ui": minor
---

Theme v2 — nineteen more brand tokens, every one optional.

`VendoTheme` carried eight colors, two type fields, three radii and two enums.
Everything the Kit and the chrome needed beyond that was a literal somewhere in
our source: the green and amber the pills paint, the mono stack, the three
shadows, the chart ramp, the border width, the chrome's own motion pair. A host
could not reach any of them. Now it can.

```ts
theme: {
  colors: { …, success: "#0a7d55", warning: "#c98a00", surfaceRaised: "#fafafa" },
  typography: { …, monoFamily: "Berkeley Mono, monospace", weightEmphasis: "650", lineHeightBody: "1.6" },
  shadow: { small: "…", medium: "…", large: "…" },
  borderWidth: "1px",
  chartPalette: ["#1d4ed8", "#0891b2", "#7c3aed"],
  motionDuration: "120ms",
  motionEasing: "cubic-bezier(.2,.8,.2,1)",
}
```

- **Every addition is OPTIONAL.** A theme file that fails to parse is discarded
  whole, so one required field would have blanked the brand of every host whose
  theme predates it. A pre-v2 theme parses and renders exactly as before.
- **The variable NAMES stay one fixed set — 52 of them.** Three transports
  (the chrome's style object, the MCP door's `style` attribute, the MCP Apps
  shim's `:root{}`) serialize the same mapping and compare their output against
  each other, and the shim's reverse read throws on a name outside the published
  list. So `themeCssVariables` resolves each optional field against a default
  and emits every name for every theme, rather than emitting a name only for
  hosts that set it.
- **The Kit reads them.** `success`/`warning` stop being Kit-only literals, a
  control's edge is `var(--vendo-border-width)`, and `chartSeries` reads
  `--vendo-chart-1..6` with the accent-derived OKLCH ramp — unchanged — as the
  per-entry fallback. One definition of that ramp now, shared by the emitter and
  the Kit.
- **Three chrome tokens re-anchor onto the contract.** `--vendo-border` keeps
  the derived ~8% hairline as its DEFAULT but a host that states `colors.border`
  finally wins instead of being ignored; the `--vendo-ok`/`--vendo-warn` family
  reads `colors.success`/`colors.warning`; and `--vendo-duration`/`--vendo-ease`
  derive from the theme's motion pair (the chrome keeps its slower feel through
  a multiplier), so one host knob moves the chrome and generated views together.

`defaultVendoTheme` is deliberately unchanged: it is the shape the MCP Apps shim
reconstructs a theme back INTO, and a field the reader cannot recover would make
a theme round-trip into a different theme. The fill-in values live beside it as
`themeDefaults`, which the Kit reads for its unthemed fallbacks — so each value
still has exactly one definition.
