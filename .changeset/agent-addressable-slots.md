---
"@vendoai/apps": minor
"@vendoai/core": minor
"@vendoai/mcp": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
"@vendoai/guard": patch
---

Agents can address a place on the page, and a slot tells the truth about what is in it.

An agent could make a person a screen, but never say WHERE it goes: a host wired
exactly one destination and everything landed there. Now a slot is something the
agent can name, the person can choose, and the page can be honest about.

**Placement is a row, not a string on the app document.** "Show this app in that
slot" moves off `doc.placements` — which is never read any more — and into real
rows in the generic collections: a pointer at `plc:<subject>:<slot>` naming who
holds the slot under which token (the single compare-and-swap arbitration
point), and a live row at `plcv:<subject>:<slot>:<token>` that exists only while
that placement holds it. That buys three things a document scan could not: a
slot can show a build that has not landed yet, a slot resolves in one query
instead of listing every app the person owns, and one app per slot is enforced
by the write instead of by whoever read last.

- `apps.place({ app, slot })` / `apps.unplace(…)` / `apps.placements({ slots })`
  on the runtime, `POST /apps/:id/place`, `POST /apps/:id/unplace` and
  `GET /apps/placements?slots=…` on the wire, `client.apps.place/unplace/
  placements` on the client.
- `place()` is one decision, not read-then-write: it compare-and-swaps on the
  pointer's revision, the loser retries against the winner's row, and the
  displaced app comes back as `evicted` so the surface can say what moved.
- `unplace()` and "clear this slot" only ever delete the token they named, so a
  stale client can never evict the app that replaced it. Tokens are never
  reused.
- Rows carry `refs.app_id`, and deleting an app sweeps them BY APP — so deleting
  an app you share can no longer leave a permanent "didn't build" card standing
  over somebody else's host markup.
- `GET /apps/placements` gates every entry on the same viewer check
  `open`/`get`/`list` use; a slot the caller may no longer view reads as empty.
  Slot ids are normalized identically on read and write, and percent-encoded per
  item in the query, so an id containing a "," survives the round trip.
- `useSlotApp(slot)` now answers `{ appId, status }`, over ONE poller per client
  shared by every mounted slot (it no longer takes `pollMs`).

**`vendo_make` takes one optional `slot`,** honoured on both engines the one
front door routes to. The slot is claimed at MINT — the instant the app id
exists, before a single token is generated — so the place the caller aimed at
shows the build forming instead of staying empty until it lands, and shows the
failure if it never does. An ask no engine landed writes the same terminal
tombstone a failed build writes, so a claimed slot turns into the honest failure
card the moment either engine gives up. A placement whose app no longer exists
renders as nothing placed, never a stuck failure card. On a CHANGE, `slot` is
refused by name: silently moving an existing app would evict whatever holds that
slot off the back of an edit nobody aimed there.

**Two new tools do the moving.** `vendo_apps_pin { app, slot }` puts an app the
user already has into a slot and reports what it replaced as `evicted`;
`vendo_apps_unpin { app, slot }` takes it out and leaves the app itself alone.
Both aim by the app's id OR the name the user said, and both are graded `write`
— a placement row is small and reversible.

Neither is offered to an unattended run, and neither is executable in one.
`PRESENCE_ONLY_TOOLS` (core) joins THE LAW's projection, and the guard's choke
point refuses a presence-only call outright — so a standing automation grant
that reaches `execute()` by name, without listing, can no longer rearrange a
page with nobody watching. Keyed on the name, not the grade, so policy rules and
consent cards still read an honest `write`. A slot-bearing `vendo_make` in an
unattended run still RUNS and simply drops the slot: placement is what needs a
person present, creation is not, and refusing the call would silently break the
automations that legitimately build screens.

**`McpDoorConfig.withholdTools`** names tools one door never offers, checked
BEFORE the `vendo_` prefix bypass and on BOTH legs of a mount — a turn-bearing
session used to be able to list and call a name the deployment said it never
offers. Curation, not security: a withheld name answers with the same in-band
not-found an unknown name gets.

**`VendoSlot` reads the placement's build status, not just its app id:**

- **building** — an EMPTY slot shows the skeleton it already uses, minus the
  invitation, because there is nothing left to ask for. A slot carrying the
  host's own markup KEEPS it until the build is ready: a working host component
  never blanks into a skeleton for the length of a build.
- **failed** — the consumer sentence (never the wire's `reason`, which names
  components and env vars and is written for whoever can fix the build), a "Try
  again" that re-issues the ORIGINAL request when the failed record kept one,
  and "Clear this slot". The failed card DOES replace the host's own children,
  deliberately: a build that will never land should not hide behind markup that
  looks fine.
- **ready** — unchanged, and now proven in a browser for both surface kinds.

**`AddToPicker` puts "Add to…" on a generated view's bar,** so a person can send
it to any slot the host has mounted instead of the one place a host wired. It
awaits `client.apps.place` before saying "Added to Hero", then announces the
placement so a mounted slot fills without waiting out its poll. It appears in
both places a generated view has a bar — the app embed and the IN-THREAD card,
which is the surface a person actually reaches a view from in every host that
renders its conversation through `VendoOverlay`. The affordance stays a
one-click "Pin to dashboard" while the origin knows a single destination — a
menu of one is not a choice — and becomes the picker the moment it knows more.

- `noteSlot` / `knownSlots` (new, re-exported from `vendoai/react`): the picker's
  destinations. A slot id is the host's markup and no Vendo record carries it, so
  a mounted `VendoSlot` recording itself in origin-scoped `localStorage` is the
  only way a surface on another page can offer that slot at all. A slot the host
  filled with an explicit `appId`/`pin` stays out of the list — a placement
  written into it would never be read.

**Pinning is Vendo's write now:** with `pinSlot` set, the pin affordance calls
`apps.place` itself. `onPin` remains as an optional side-effect seam, so a host
no longer needs a pin route of its own (Maple's is deleted).
