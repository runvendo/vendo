---
"@vendoai/harnesses": minor
"@vendoai/vendo": patch
---

The screen agent IS `vendo()`, and the checks floor rides the `vendo_make` route.

## `vendo()` takes a closed loadout

`VendoHarnessDeps.tools` is new. Set, the equipped set is EXACTLY that list: a
string equips that registry tool (guarded, through `turn.tools.call`, as today);
a `HarnessHand` — `{ name, description, inputSchema, execute(input, turn) }` — is
the harness's own hand, invisible to every other consumer. No discovery rail
(`find_tools` is not mounted: a fixed loadout has nothing to discover), no
`vendo_*` always-active exemption, no `hire_subagent` unless the list names it. A
name the deployment's listing does not carry is simply not offered, because that
list is written once at boot against a listing that legitimately varies per
deployment.

Unset — every existing caller — behaves exactly as before.

`execute` receives the TURN, which is what lets a hand be declared where a
`Harness` value is built (no run in sight) while its effects are per-run:
`turn.workspace` is this run's files.

## The screen agent is configuration, not a second loop

`screenAgent()` / `screenAssembler()` keep their doors, their brief, their
`SCREEN_STEPS = 10` budget and their outcome semantics, but the bespoke
`startTurn` drive underneath them is gone: they are now `vendo()` with a closed
loadout and two hands (`save_app`, `escalate`). The step cap, the seat
resolution, `wireErrorMessage`, the context knobs and the system precedence are
the default harness's, so a rail cannot be fixed in one loop and stay broken in
the other.

## Fixed: a screen assembled through `vendo_make` was never checked

Composition wired the screen slot's render seam without the checks floor, while
the harness-turn route passed `{ authoredApp, commitSource, floor }`. One seam,
two answers: the same `app.vendo` — a binding naming a tool the host has not got,
a prop the renderer drops — was refused on the harness route and painted on the
`vendo_make` route, where it also compiled in the wrong dialect (no inline tool
expansion, `bindingErrors: []` by construction) and never persisted its source.

The screen slot now carries the same `floor` and `commitSource`. A blocking
finding means nothing paints and the last good view stays, exactly as everywhere
else; the write still lands, so `validate` can read it back and repair it. Hosts
need no code change.
