---
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

A slot tells the truth about the app placed in it, and any surface can put one there.

`VendoSlot` reads the placement's build status, not just its app id:

- **building** — an EMPTY slot shows the skeleton it already uses, minus the
  invitation, because there is nothing left to ask for. A slot carrying the
  host's own markup keeps it until the build is ready: a working host component
  never blanks into a skeleton for the length of a build.
- **failed** — the consumer sentence (never the wire's `reason`, which names
  components, expressions and env vars and is written for whoever can fix the
  build), a "Try again" that re-issues the ORIGINAL request and is offered only
  when the failed record kept one, and "Clear this slot" — the unplace the
  host's own markup comes back from.
- **ready** — unchanged, and now proven in a browser for both surface kinds: a
  tree payload and a served machine url.

`AddToPicker` puts "Add to…" on the app embed's bar, so a BYO chat page can send
a generated app to the dashboard without a host-built pin control. It awaits
`client.apps.place` before saying "Added to Hero", then announces the placement
so a mounted slot fills without waiting out its poll.

- `noteSlot` / `knownSlots` (new, re-exported from `vendoai/react`): the picker's
  destinations. A slot id is the host's markup and no Vendo record carries it, so
  a mounted `VendoSlot` recording itself in origin-scoped `localStorage` is the
  only way a surface on another page can offer that slot at all. A slot the host
  filled with an explicit `appId`/`pin` stays out of the list — a placement
  written into it would never be read.
