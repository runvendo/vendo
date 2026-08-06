---
"@vendoai/core": minor
"@vendoai/apps": minor
"@vendoai/mcp": minor
---

Agents can address a place on the page.

`vendo_make` takes one optional `slot`, honoured on both engines the one front
door routes to: an assembled screen claims the slot the moment its row lands,
and an ask that escalates to a real build claims it at mint — so a build that is
still running occupies the place the caller aimed at instead of appearing later
out of nowhere. On a CHANGE, `slot` is refused by name: silently moving an
existing app would evict whatever holds that slot off the back of an edit nobody
aimed there.

Two new tools do the moving. `vendo_apps_pin { app, slot }` puts an app the user
already has into a slot and reports what it replaced as `evicted`;
`vendo_apps_unpin { app, slot }` takes it out and leaves the app itself alone.
Both aim by the app's id OR the name the user said, like every other door in
this registry, and both are graded `write` — a placement row is small and
reversible.

Neither is offered to an unattended run. `PRESENCE_ONLY_TOOLS` (core) joins THE
LAW's projection: a tool whose whole effect is on a person's screen has nothing
to act on when nobody is looking, and rearranging a dashboard someone comes back
to is a change they never saw being made. Keyed on the name, not the grade, so
policy rules and consent cards still read an honest `write`.

`McpDoorConfig.withholdTools` — names one door never offers, checked BEFORE the
`vendo_` prefix bypass. The bypass protects the product's plumbing from a HOST's
curated menu; this is the deployment's own decision about its own door. Curation,
not security: a withheld name answers with the same in-band not-found an unknown
name gets.
