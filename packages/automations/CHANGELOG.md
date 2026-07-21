# @vendoai/automations

## 0.4.1

### Patch Changes

- Updated dependencies [b7a860f]
  - @vendoai/core@0.4.1
  - @vendoai/apps@0.4.1

## 0.4.0

### Minor Changes

- 0032a67: Add optional atomic record claims and revision CAS, use them to deduplicate multi-instance automation firing, and abort in-process agentic runs when stopped.

### Patch Changes

- 4b8ac66: Per-user connected accounts via the Composio broker (ENG-262). Connectors gain a subject-scoped `connections` capability (list/initiate/status/disconnect); the umbrella serves per-principal `/connections` endpoints with a Vendo Cloud broker seam behind `VENDO_API_KEY`; a Composio call missing a connection returns the new typed `connect-required` tool outcome, rendered by `VendoThread` as an inline connect card that retries after connecting; `ConnectedAccountsPanel` (list + disconnect) joins the chrome as the accounts tab. Composio tools carry curated risk (metadata hints + slug patterns) instead of a blanket `write`; the MCP connector accepts an async per-principal `headers` resolver with per-subject sessions; every connector execution is audited with its account identity.
- dab84c2: Performance: bound the automations tick and the agent's per-turn context.

  - **automations**: the tick fetches only schedule-triggered apps through an indexed
    `trigger_kind` ref (was a full scan of every app for every subject) and batches every
    schedule cursor into one query (was an N+1 get per app). Fired automations now execute
    with bounded parallelism (`tickConcurrency`, default 4) and an optional per-run timeout
    (`runTimeoutMs`), so one hung run cannot block other tenants or overrun the tick
    interval. `emit` likewise fetches only the subject's host-event apps. `/tick` still
    returns the same runIds.
  - **agent**: Anthropic prompt-caching breakpoints on the static system prompt and the
    stable history prefix (ignored by other providers); a default tool-output cap so one
    huge host-tool response cannot blow the context (`config.agent.toolOutputCap`); a new
    `historyWindow` knob bounding what is re-sent per turn (default: the full thread, as
    before); and thread listing that derives titles from a stored `title` instead of loading
    every thread's full message array.
  - **store**: btree indexes backing the `(created_at, id)` keyset pagination on
    `vendo_records` and the paged MCP tables, a generated `trigger_kind` column on
    `vendo_apps`, and a `title` column on `vendo_threads`. All applied as additive DDL — no
    schema-version bump and no data migration.

- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.
- Updated dependencies [49e9ccc]
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [023b3c0]
- Updated dependencies [fa0ad98]
- Updated dependencies [0e94fa6]
- Updated dependencies [7826a6e]
- Updated dependencies [7546de1]
- Updated dependencies [51f3fc9]
- Updated dependencies [dab84c2]
- Updated dependencies [ff6b5d5]
- Updated dependencies [8d5423d]
  - @vendoai/core@0.4.0
  - @vendoai/apps@0.4.0
