---
"@vendoai/apps": minor
"@vendoai/vendo": minor
---

The agent's data tools move onto `appData` — one user can no longer see another's rows.

`vendo_apps_data_list` / `_put` / `_delete` are how the embedded agent saves and
reads an app's declared storage on the person's behalf. They landed in the
generic `records` family, which has no answer to "whose row is this": every
user of an app wrote into one flat collection, and the only thing between them
was that nobody had asked.

Now every one of those calls carries `ctx.principal.subject` — the LIVE caller,
off the run context, never off the tool args — into the owner-stamped `appData`
family. `put` stamps the row with that subject, `list` ANDs it into the query,
`get` answers `null` for another owner's row and `delete` no-ops on one. A
cross-user read is no longer forbidden; it is unexpressible. An id another owner
already holds refuses with `conflict` rather than being taken over, and that
refusal is surfaced honestly rather than swallowed. Declared file collections
get the same treatment through the family's file twins.

Nothing about what an app may declare changed. The guards keep their posts in
the same order — the declaration check (with `state` still reserved), the
declared-refs check, the 256 KB record cap, the 5 MB blob cap — and app state
(`vendo_state`) stays on the `StoreAdapter` façade, deliberately.

`AppsConfig` gains an optional `ops` slot that the umbrella fills with the same
`StoreOps` surface the deployment already selected. Its absence is a real
answer, not a failure: a store that offers neither its own ops nor a SQL handle
keeps exactly today's behavior instead of crashing composition at boot.
