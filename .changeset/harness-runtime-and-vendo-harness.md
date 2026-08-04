---
"@vendoai/harnesses": minor
"@vendoai/core": minor
---

Add `@vendoai/harnesses` — the runtime that runs any harness, plus `vendo()`.

Who thinks becomes a swappable adapter. A harness receives a `Turn` (the
canonical transcript, guarded tools, pack skills, the workspace, the model seats)
and yields a closed four-member event vocabulary; the runtime does everything
else, so a harness author cannot forget the safety story.

New in `@vendoai/harnesses`:

- `defineHarness(def)` — returns the value itself. A harness needing host
  dependencies is a plain factory closure; there is no factory concept.
- `createHarnessRuntime(deps)` — builds the `Turn`, runs the harness, converts
  events plus mirrored tool calls into the EXISTING ai-SDK UIMessage stream with
  today's `data-vendo-*` parts, persists the transcript one row per message, and
  enforces the routing table (`text` → screen + transcript · `status` → screen
  only · `error` → screen + audit · `usage` → audit only). Tool calls are
  mirrored by the runtime, never yielded.
- `vendo()` — the default in-process, key-free thinker. It DRIVES the shipped
  `@vendoai/agent` turn loop rather than reimplementing it, so the step cap,
  `buildFailedStop`, the history window, the cache breakpoints and the
  tool-search loadout are shared. Tools execute through `turn.tools.call()`,
  which runs the shipped guarded-call path — the guard, the audit row, the view
  channel and the transcript mirror included. It also hires its own bounded
  subagents; every hire is metered and leaves an audit row plus a receipt.
- `assertHarnessComposable(harness, { sandbox })` — `requires: { sandbox }` is a
  boot-time composition error, never a runtime surprise.
- The hot-path render seam: a commit that lands `app.vendo` or `plan.vendo` emits
  today's `data-vendo-view` part on the stable per-app stream id, so the skeleton
  reaches the screen whoever wrote the file. An unparseable or conflicted commit
  emits nothing and the last good view stays.
- `turn.state` — opaque harness state, persisted at turn end, cleared by a
  harness swap or an arbitrary history edit.

New in `@vendoai/core` (types only, so every block may speak them): `Harness`,
`Turn`, `TurnTools`, `ToolResult`, `DeniedNeeds`, `ToolListing`, `TurnSkills`,
`SkillListing`, `TurnState`, `HarnessEvent`, plus the two seams `Turn` is typed
against — `WorkspaceFs`/`CommitResult` and `Seat`/`ResolvedModels`. `ai` and
`just-bash` join core as OPTIONAL peer dependencies (type-only imports; hosts
that do not touch these shapes install neither).
