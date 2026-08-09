---
"@vendoai/core": minor
"@vendoai/apps": minor
"@vendoai/ui": minor
---

Three shapes the apps runtime produces and the client consumes now have exactly
one definition, in core.

`@vendoai/ui` may not import `@vendoai/apps` (the dependency guard's layering
rule), so it re-declared the wire shapes it reads "verbatim from the frozen
contract text". That is a promise, not a mechanism. `pinComponentName` — the
generated-component name a forked host slot ships under, and therefore the name
the client's in-place mount looks the node up by — existed as THREE hand-written
copies: `apps/pins.ts`, ui's `<Remixable>` wrapper, and ui's wire fixture.

Moved into `@vendoai/core`:

- `pinComponentName` → `core/app-document.ts`, beside `Pin` (it is a pure
  function of `Pin.slot`).
- `PlacementEntry` and `ReviewStanding` → `core/app-surfaces.ts`, a new module
  whose membership rule is one line: apps produces it, ui consumes it off the
  wire.

No package's public surface changes. `@vendoai/apps` still exports
`pinComponentName`, `PlacementEntry` and `ReviewStanding` from the same modules
as before, and `@vendoai/ui` still exports `PlacementEntry` and `ReviewStanding`
from its root — each is now a re-export of core's single definition.

`PinForkResult` was deliberately NOT unified. Its own fields match on both
sides, but its `edit?: EditResult` does not: apps' `EditResult` carries
`failure`, `graduated`, `box` and `pendingEgress`, which ui's copy never grew,
and the wire returns the runtime's result untrimmed. Unifying it would widen
`@vendoai/ui`'s published `EditResult` — a contract change, not a refactor.
