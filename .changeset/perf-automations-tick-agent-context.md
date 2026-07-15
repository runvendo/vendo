---
"@vendoai/automations": patch
"@vendoai/agent": patch
"@vendoai/store": patch
"@vendoai/apps": patch
"@vendoai/vendo": patch
---

Performance: bound the automations tick and the agent's per-turn context.

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
