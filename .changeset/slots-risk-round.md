---
"@vendoai/apps": patch
"@vendoai/core": patch
"@vendoai/guard": patch
"@vendoai/mcp": patch
"@vendoai/ui": patch
"@vendoai/vendo": patch
---

Risk-round fixes on the placement stack.

- `GET /apps/placements` is an app read. `entryFor` raw-read the app row, so a
  viewer whose grant was taken back kept reading a placed app's title and its
  live build status after `open`/`get`/`list` had all gone back to not-found.
  Every entry now passes the same `can()` check those paths use, and a slot the
  caller may no longer view reads as empty.
- `place()` is one decision, not read-then-write. The eviction receipt used to
  be a separate read, so two places into the same slot could both answer
  "nothing was replaced" while one of them was silently displaced. The write
  now compare-and-swaps on the row's revision and the loser retries against the
  winner's row.
- `unplace()` can no longer clear the app that replaced it. A placement is now
  two rows: a pointer at `plc:<subject>:<slot>` that says who holds the slot
  under which token (the single CAS arbitration point), and a live row at
  `plcv:<subject>:<slot>:<token>` that exists only while that placement holds
  it. A clear deletes the token'd row and nothing else, and tokens are never
  reused, so a stale client's delete can only ever hit its own placement.
  Pointers live in their own generic collection (`vendo_placement_slots`), so
  `vendo_placements` still holds exactly one row per live placement.
- A `vendo_make` that names a `slot` still builds when nobody is there, and
  simply takes no slot. Placement is what needs a person present; creation is
  not, and refusing the whole call would silently break the automations that
  legitimately create screens. `presenceOnlyCall` now names the pin tools and
  only those.
- The presence-only law now has the second layer the destructive half has
  always had. `projectableForRun` only decides what a run is OFFERED; the
  guard's choke point refuses a presence-only call outright, so a standing
  automation grant can no longer rearrange a page with nobody watching.
- `withholdTools` holds on both legs of an MCP mount. A turn-bearing session
  listed and could call a name the deployment said it never offers.

Second round, on the pointer/live-row split the first round introduced.

- A `place()` that dies between writing its live row and swinging the pointer
  no longer strands that row. Until the pointer lands nothing names the row, so
  a failed swing takes it back out; every retry used to leave one more row that
  nothing read and nothing collected, against the "exactly one live row per
  slot" count the seam readers take. `place()`'s comment claimed a cleanup no
  code performed; it now describes what the code does.
- Deleting an app leaves no placement behind. The clear removed only the live
  row, so the pointer kept the dead app's id, its `placedBy` and its timestamp
  forever — nothing in the tree ever removed a pointer, and one accumulated per
  slot a person ever used. The pointer now goes too, and only while it still
  names the token being cleared, so a place that took the slot in between keeps
  it.
- Deleting a SHARED app clears it out of everyone's slots, not just the
  deleter's. Placement rows carry `refs.app_id` (the ref `egress-approval.ts`
  clears an app by) and the sweep is by app, so a co-owner's delete can no
  longer leave a permanent "didn't build" card standing over another person's
  host markup.
- `placements({ slots })` normalizes the slot id the same way every write does,
  so `place(" hero ")` is findable as `" hero "`. Only the write trimmed before.
- A slot id containing a "," survives the wire. The client joined slot ids on
  "," and the route split on ",", so such an id was writable and permanently
  unreadable. Each id is now percent-encoded on its own inside the list and
  decoded per item after the split.
