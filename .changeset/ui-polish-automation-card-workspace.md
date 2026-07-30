---
"@vendoai/ui": minor
"@vendoai/agent": minor
"@vendoai/apps": minor
"@vendoai/vendo": patch
---

Chrome polish wave + the automation card's missing emitter.

- **Status ribbon docks onto the composer** (Codex-style): narrower than the
  composer, top corners only, its bottom edge tucked behind the card — no more
  floating pill with a gap, on both the page surface and the overlay's
  dock-anchor DOM.
- **Approval card de-escalated**: the ceremony card keeps the neutral surface
  with a single amber accent bar instead of the full yellow wash; the
  ALL-CAPS "CRITICAL" eyebrow is gone; risk slugs render in the user's
  language ("Irreversible", "Makes changes", "Read-only") with the raw slug
  intact on `data-risk` and the tooltip.
- **App-card dot stands down when ready**: the pulsing build dot fades and
  collapses once the view is generated; the ready bar carries just the name.
- **`.fl-btn` is a non-wrapping flex row**: icon + label ride one line (the
  connect card's "Connecting…" spinner no longer folds onto its own line).
- **`VendoPage` accepts `thread`** (`suggestions` + `discoverability`
  passthrough to the chat tab), so hosts can move their curated landing onto
  the full workspace; Maple's Ask Maple page and Cadence's assistant now
  render the workspace console.
- **The automation card now actually streams**: `vendo_apps_edit` ok-outputs
  that armed an automation emit `data-vendo-automation` from the agent tool
  bridge (name-scoped, 01 §16), and the apps runtime reports the armed
  trigger's true `enabled` state on `EditResult.automation`. The playground
  gallery gains an "Automation created" scenario.
