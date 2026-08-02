---
"@vendoai/ui": minor
---

A pin now has a payoff. Pinning a generated view used to be silent: the panel
stayed open over the page, and the slot showed the app whenever its next ≤5s
poll happened to fire — nothing connected the click to the result.

Every pin affordance (the in-thread card bar and the workspace stage) now runs
one sequence, graduated from the Keystone demo:

1. the panel dismisses first, because the payoff is on the page and the card
   being pinned sits in a modal over a scrim;
2. a ghost of the card flies into the slot (300ms) and the slot takes a settle
   pulse (180ms) — 480ms total, deterministic, and the slot is scrolled into
   view first so the landing is actually watchable;
3. the slot re-reads on the pin event instead of waiting for the poll tick.

`prefers-reduced-motion` keeps the dismiss and the pulse and skips the flight.
The ceremony is presentation only — the pin is still whatever the host's
`onPin` writes — so a slot that is not mounted means no animation rather than a
stranded ghost.

New public surface, all optional:

- `usePinAction()` (`@vendoai/ui/chrome`) — what the built-in affordances call.
- `playPinCeremony({ appId, slot, dismiss })` — the same sequence for a host
  running a pin from its own control.
- `announcePin(appId)` / `onPinAnnounced(listener)` (`@vendoai/ui`) — the bus
  `useSlotApp` listens on, for hosts that pin outside a Vendo surface.
- `pinSlot` on `VendoRoot`/`VendoProvider` — the ceremony's destination. Only
  needed by hosts mounting several slots; with one, the ceremony finds it.
