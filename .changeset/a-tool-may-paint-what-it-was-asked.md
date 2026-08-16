---
"@vendoai/apps": minor
"@vendoai/ui": minor
---

The theme is the default, no longer the law: every Kit component takes `style`, and the ones wrapping an engine pass that engine's own props through.

The Kit used to expose no color input anywhere — a design law ("never invents a color") that read as brand safety and played out as a dead end: a person asked for rainbow chart lines, the model wrote the hexes into the app, and the surface painted theme grey while the assistant claimed otherwise. Now `style` lands on every component's root (user values winning over Kit defaults), chart components pass recharts props through — including per-series, where `color` on a series entry paints the line's stroke or the bar's fill — and Base UI-backed components pass theirs. Wiring props the component must own (data keys, ids) stay Kit-owned; a passthrough prop that was never set keeps the theme's default rather than blanking it.

The agent-facing docs say all of this plainly (theme by default, engine props when the person asks), and the checks admit engine props instead of flagging them. No compatibility promise rides along: an engine upgrade may retire a prop an old stored app used, and that app renders with theme defaults until regenerated.
