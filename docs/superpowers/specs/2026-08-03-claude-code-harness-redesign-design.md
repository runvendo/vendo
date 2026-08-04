# claudeCode() harness redesign — capability-first

**Date:** 2026-08-03 · **Status:** approved in conversation, pending spec review
**Scope:** the `claudeCode()` harness only. The `vendo()` harness gets its own round after this lands; nothing here changes its behavior.

## Why

The harness works but under-delivers: the permission hook denies tools the SDK
legitimately offers (`MultiEdit`, `NotebookEdit`, `Skill`), the loadout curates
tools off a surface whose model handles large listings natively, app generation
is a coin flip between two paths, and the model is under-fed on exactly the
material it is best at consuming (reference files, schemas, a checker loop).
Direction set with Yousef 2026-08-03: **prioritize capability**; the box is the
security boundary, the door is the permission system, everything else gets out
of the model's way.

## Decisions

### D1 — Permissions: bypass + a three-name deny-list

`packages/apps/src/claude-turn.ts`

- `permissionMode: "bypassPermissions"`.
- **Delete** `canUseTool` (`boxPermission`) and `allowedTools` entirely.
- `disallowedTools: ["WebSearch", "WebFetch", "AskUserQuestion"]` stays — the
  only local tool law. Everything else the SDK ships, now or later, runs.
  - *Build-time amendment 2026-08-03:* five names added, so the list is eight
    rather than three — `Projects`, `Artifact`, `RemoteTrigger`,
    `PushNotification`, `SendFeedback`. Not a walk-back of "everything else
    runs": these act on the vendor's own surfaces over the inference channel,
    not through this host, so they pass neither the box nor the door
    (`Projects`' `project_write` uploads a workspace file provider-side with no
    audit row and no egress filter). `allowDangerouslySkipPermissions: true`
    added beside the mode — the SDK documents the two as a pair; today's CLI
    treats it as advisory (measured 2026-08-03).
- Rationale: the box is a copy with no credentials and filtered egress — the box
  IS the permission. Host tools are still guarded at the door; nothing about
  that moves. The old allow-list was already denying tools its own sync hook
  expected (`WRITING_TOOLS` names `MultiEdit`/`NotebookEdit`).
- The `PostToolUse` file-sync hook is not a permission mechanism and stays.

### D2 — Tool delivery: everything on the door, no loadout

- The claude-code door listing drops the loadout filter (`activeToolNames`):
  the door lists **everything the context projects**. The safety projection
  (design §12 — unattended runs never see destructive/external tools) still
  runs before the listing and is not weakened by this change.
  - *Amendment 2026-08-03, after #747 landed:* that projection is no longer the
    same set. #747 withholds `ungraded` from an unattended run alongside
    `destructive`, and re-grades every extracted GET to `ungraded` ("GET is not
    a fact about reading"). Because D2 deleted the loadout, "everything the
    context projects" is now the WHOLE story — so an unattended claude-code run
    against a catalog nobody has judged sees **zero host tools**, where before
    it saw a loadout of nominally-`read` ones. That is #747's deliberate
    fail-closed posture meeting D2's uncurated listing, not a defect in either;
    the practical consequence is that `vendo judge` (or hand-written
    `judgments.json`) becomes a prerequisite for unattended automation on this
    harness. Flagged for Yousef rather than worked around.
- One MCP mount, `alwaysLoad: true`, exactly as today. No door split: the
  listing is naturally bounded because connector toolkits materialize lazily —
  the 20k-tool Composio catalog is never ON the list.
- `vendo()`'s loadout is unchanged (other-harness round).

### D3 — Discovery collapses to two Composio-scoped tools

With the loadout gone, search-over-listed-tools has no job on this path. What
remains is reaching the unexpanded connector catalog:

- **`search_connectors`** — search the connector catalog by intent; expands a
  matching toolkit server-side so found tools become callable on the door's
  next listing. Backed by **Composio's own search API** inside the connector
  adapter (their index, their ranking); our wrapper maps results to our
  namespaced tool names, triggers lazy expansion, annotates per-user connect
  status. Adapter-shaped: another provider (or none) fills the slot the same way.
  - *Build-time deviation 2026-08-03 (flagged for Yousef):* shipped on the
    existing local index instead of Composio's search API, on three pieces of
    evidence — the default `VENDO_API_KEY` path rides the console broker,
    which has no search endpoint (their API would serve only BYO-Composio and
    leave two ranking paths that disagree); their endpoint returns no
    relevance scores (we would re-rank anyway); and it ranks tools while
    callability requires toolkit expansion regardless. The adapter seam
    stands, so swapping the backend later is contained.
- **`list_connections`** — read-only: available toolkits + this user's
  connection status (the dock catalog query, exposed to the model — Composio's
  `MANAGE_CONNECTIONS` equivalent, minus initiation). Connecting stays a UI act
  (connect card / button), never a tool call.
- Both exist **only when connectors are configured**. A connector-less host's
  agent has zero discovery machinery.
- `find_tools` (and the meta-tool plumbing in `discovery.ts`) stays as-is on the
  `vendo()` path; `COMPOSIO_MULTI_EXECUTE_TOOL` is explicitly rejected (would
  bypass guard/audit).

### D4 — App generation: files-first; the engine leaves this surface

- `vendo_apps_create` and `vendo_apps_edit` are **not projected** to the
  claude-code surface. The model builds and edits apps by writing `plan.vendo` /
  `app.vendo` with its own hands; the render seam (§1.6) repaints the user's
  screen on every parsing save.
- Staffing is the SDK's native `Task` subagents, per the skill ("run me in a
  fresh subagent"; parallel workers per group). No orchestration code from us.
- `vendo_apps_open`, `vendo_apps_rebase_pin`, `vendo_apps_data_list/put/delete`
  stay projected — lifecycle, not generation.
- The engine and both tools remain untouched for `vendo()` and BYO loops.
- The `validate` verb (`packages/agent/src/vendo-verbs.ts`, wired at
  `server.ts:2323`) already rides the door and is the review floor:
  **validate-must-pass before the builder reports done** (skill law, D7).
  A live E2E proof of the loop (write bad file → validate findings → fix →
  screen updates) is a required verification, since nothing tests it today.

### D5 — Project `outputSchema` through to the model

Extraction already captures per-operation output schemas
(`packages/actions/src/sync/openapi.ts`) and drops them at the descriptor
boundary. Add `outputSchema?: JsonSchema` to `ToolDescriptor` → `ToolListing` →
door listing (MCP supports output schemas natively). The model learns every
query's field names from the listing itself. "Call the query and look at real
rows first" demotes to a skill fallback for tools without declared output
schemas, or when sample values matter.

### D6 — Feed the model files (its native strength)

- **`/host/components/<Name>.md`** — one file per catalog entry: full
  description, props schema, examples. Extends the existing `/host` mount
  projection (`packages/core/src/skills.ts` pattern). `search_components` stays
  as the quick lookup; the full reference is on disk and greppable.
- **`references/format.md`** beside the `building-apps` SKILL.md — the complete
  `.vendo` syntax: every element, every expression function, layout attributes,
  one worked full-app example. Native skill companion files; the skill body
  stays one screen per section.

### D7 — `building-apps` skill rewrite

Same bones, corrected details, all claude-code-native:

- Correct tool names — build-time correction 2026-08-03: the question tool IS
  `ask_user` (`ASK_USER_TOOL` in core); the spec's earlier `vendo_ask_user` was
  wrong and the skill keeps `ask_user`. `validate` invoked explicitly after
  every save of `plan.vendo`/`app.vendo` (document form — `validate({document})`;
  the appId form requires a stored app).
- Validate law: the builder subagent does not report done until `validate`
  returns clean.
- Staffing: name the SDK's `Task` tool for the fresh-subagent and
  one-worker-per-group instructions.
- The user's ask travels **verbatim** into the subagent brief, plus relevant
  conversation constraints — never paraphrased.
- The engine's data-honesty and branding laws move in as skill law: never bake
  computed/fetched values into markup; never specify fonts, colors, or branding
  — components carry the host theme.
- Data grounding: read the tool listing's output schema first; call the query
  once for real rows only when the schema is missing or sample values matter.
- Points at `references/format.md` and `/host/components/` for depth.

### D8 — Prompt: harness-aware sections, app-default line, brief at ~6 lines

`packages/agent/src/prompt.ts` + `embeddingBrief` in
`packages/harnesses/src/claude-code/index.ts`. One assembler, small
harness-conditional sections — never a forked prompt (the mid-conversation
harness-swap law depends on shared policy text).

- The discovery-budget section is wrong for this harness (teaches `find_tools`).
  Claude-code turns get a connectors section instead: what `search_connectors` /
  `list_connections` are, connect etiquette (unconnected service → say so
  plainly, point at the connect button, no substitute-hunting).
- New app-default line (both harnesses): when someone asks for something to
  look at, track, or use — build them an app rather than describing data in
  text; the `building-apps` skill is the manual.
- The embedding brief grows to ~6 lines: embedded in this product, talking to a
  customer, plain language; files at the workspace root; `vendo` tools are the
  product's real actions, refusals said plainly; apps are how you show things
  (skill pointer); the session persists across turns.
- Presentation rules unchanged and load-bearing (don't restate a rendered
  view's data).

## Out of scope (named, deliberate)

- The `vendo()` harness round: its loadout, `find_tools` naming, subagent
  briefing, `hire_subagent` depth. After this lands.
- Hook-based auto-validate on save (linter-style PostToolUse feedback) — needs a
  box→host channel; the explicit `validate` tool covers the loop.
- Cloud door relay (would let `machine: "local"` be deleted).
- Composio-backed ranking inside `vendo()`'s `find_tools`.

## Verification

**Nothing is "done" until the live E2E proofs below pass — gates and unit tests
alone do not count (Yousef, 2026-08-03).**

- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.
- Live E2E on the sandbox path, real browser: (1) build an app via files —
  skeleton renders mid-turn, sections grow, validate loop demonstrated on an
  induced error; (2) `search_connectors` → expansion → call → connect-required
  card; (3) an SDK tool formerly denied (`MultiEdit` or `Skill`) now works.
- Door audit rows for every host-tool call (the cc-native parity gate stands).
- UI-affecting proofs carry screenshots in the PR.
