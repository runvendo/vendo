# Shelf-core browser verification (2026-07-18)

Real-browser verification for the ui-shelf-core lane (thread refactor, overlay
thread seam, slot discovery + remix flag, palette defaults, mobile sheet).
Demos booted from this branch with the live wire (demo-bank on :3010,
demo-accounting on :3011).

| Shot | What it proves |
| --- | --- |
| `01-thread-generated-view.png` | Refactored VendoThread streams a real turn on Maple `/vendo`; the generated spending view renders in the jailed app card. |
| `02-thread-approval-card.png` | A destructive transfer parks the in-thread approval card (risk badge, args, Remember panel) rendered by `chrome/thread/parts.tsx`. |
| `04-overlay-desktop.png` | Overlay opens over Maple via the host Cmd+K wiring after the refactor. |
| `05-overlay-mobile-sheet.png` | At 390x844 the overlay is the full-screen `.fl-takeover` sheet with safe-area header actions. |
| `06-slot-remix-hover.png` | The `remix` flag renders the hover Remix affordance on Cadence's hero slot (replacing the hand-rolled RemixButton). |
| `07-remix-opens-overlay.png` | Activating Remix opens the overlay with the remix prompt delivered through the registry and auto-sent; no `vendo:remix`/setTimeout glue. |
| `08-remix-built-view.png` | The remix build completes in the overlay with the pinnable app card. |
| `09-slot-discovery-pinned.png` | The pinned remix mounts in place of the hero card in the dashboard slot. |

Notes:

- Approve on a parked in-thread approval records the guard decision
  (`POST /approvals/decide` 200) but the native resume stalls and the card
  stays parked. Reproduced identically on a pristine `origin/main` checkout
  (same prompt, same surface), so it is pre-existing and not introduced by
  the thread refactor. Filed in the PR notes.
- Server-side slot pins: neither the old hand-rolled SWR dance nor the new
  discovery finds a pin in the Cadence demo because the demo's pin flows
  never write `pins` onto the app document (`/api/vendo/apps` shows
  `pins: null` after both remix paths). The discovery path over real pin
  fixtures is covered by `packages/ui/test/chrome/slot-discovery.test.tsx`;
  the in-page mount in shot 09 rides the host `vendo:pin` event path, as it
  did before this lane.
