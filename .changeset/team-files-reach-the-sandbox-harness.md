---
"@vendoai/harnesses": minor
"@vendoai/apps": minor
"@vendoai/store": minor
"@vendoai/core": minor
---

A team-shared file now reaches the `claudeCode()` sandbox — and its edits come home.

Orgs, teams and sharing shipped, and the sandbox harness never learned. On
`claudeCode()` a file in an `/orgs/<org>` mount was invisible: "update our team's
Quarterly Report app" answered that it does not exist, or built a personal
duplicate. Worse, when a path did reach the box, the edit was filtered out on the
way back — the agent said "done" and the write was dropped with no error
anywhere. The same ask on `vendo()` worked, because the in-process façade asked
`can()` and the sandbox path asked a hardcoded table of two mount prefixes.

Permission on the sandbox path is now the workspace's, per file:

- `WorkspaceFs.canCommit(path)` (new) answers "may this caller land a write
  here?" against LIVE rows — the same question `commit()` already asked itself
  per staged path. `/host` and anything outside the caller's mounts answer false;
  inside `/orgs/<org>/apps/<appId>/**` the app's own grants decide.
- Checkout materializes every visible file and marks it read-only per FILE, so a
  viewer-level team app lands read-only beside an editable one and the model
  meets the refusal when it reaches for the file — not after rewriting it.
- Sync-back re-asks the same question against live rows for writes and for
  deletions, so a grant revoked mid-session bites, and one refused org path can
  never take the caller's own work down with it.
- A team app's `plan.vendo`/`app.vendo` are watched mid-turn like a personal
  app's, so its skeleton paints during the turn instead of at the end.

`@vendoai/apps` is in this bump because the box door it publishes
(`box/turn-routes.mjs`, the `./box-door` export, shipped in the machine image)
carries the other half: its whole-tree and by-shape walks used to answer about
`/user/` only, so a team file's edit was left on the box's disk. A new
`@vendoai/harnesses` against an old `@vendoai/apps` is this bug again — the two
must move together.

For hosts this is additive: `WorkspaceFs` is produced by
`workspaceStore(store).open(...)` and consumed, never implemented — the new
method only widens what you can call on the workspace you already hold.
