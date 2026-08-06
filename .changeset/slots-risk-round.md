---
"@vendoai/apps": patch
"@vendoai/core": patch
"@vendoai/guard": patch
"@vendoai/mcp": patch
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
- A `vendo_make` that names a `slot` is presence-only, like the pin tool: the
  slot claims a place on somebody's page and evicts whatever held it, so an
  unattended run still builds but takes no slot. Plain makes are not regraded.
- The presence-only law now has the second layer the destructive half has
  always had. `projectableForRun` only decides what a run is OFFERED; the
  guard's choke point refuses a presence-only call outright, so a standing
  automation grant can no longer rearrange a page with nobody watching.
- `withholdTools` holds on both legs of an MCP mount. A turn-bearing session
  listed and could call a name the deployment said it never offers.
