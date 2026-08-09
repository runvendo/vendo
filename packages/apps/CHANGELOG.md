# @vendoai/apps

## 0.9.0

### Patch Changes

- Updated dependencies [18c77cd]
  - @vendoai/core@0.9.0

## 0.8.1

### Patch Changes

- 38b32a3: Security fix — a revoked secret no longer survives inside a box. When an owner
  turned a secret grant off, Vendo rebuilt the box's boundary env without that
  secret and pushed it to the machine, but the in-box supervisor MERGED the new set
  over the box's own process environment, where the value from provisioning still
  sat (a sandbox provider applies create-time env box-wide). The revoked key was
  simply absent from the new set rather than removed, so every app restart — and
  every in-box agent task — kept handing out a credential the owner had taken away,
  for the life of the machine. The boundary env now REPLACES the provisioned one:
  the app and the agent get exactly what the host injected plus the machine's own
  vars (`PATH`, `HOME`, …), so absence means gone.

  If you have already revoked a secret, two things are needed. First the box image:
  the supervisor is baked into it, so only machines created from a rebuilt template
  carry the fix — rebuild it (`packages/apps/box/build-template.mjs`) and point `VENDO_BOX_TEMPLATE`
  at the new id if you run your own sandbox account (on Vendo Cloud the image
  arrives with the release). Then, per affected app, `machine.destroy` followed by
  `machine.provision`: an existing machine's snapshot froze its environment at
  provision time and no wake re-sends it, so that snapshot keeps the old value until
  the machine is replaced. Nothing is stale on disk — the value only ever lived in
  the box's process environment, and the boundary env file the fix now treats as
  authoritative is rewritten on every injection, so a re-provisioned app self-heals
  with no migration. Rotating the credential is still the only way to invalidate a
  value a box has already read.

- 2fd14aa: An edit that did not save says so, and the format reference stops denying `<Plan display>`.

  A refused save degrades rather than throws — the app is on screen, it just is not in the
  store — and the assembler sits between that save and `edit()`, so the refusal had nowhere
  to go: `assembleEdit` re-read the row, found the PRE-edit document, and handed it back with
  no `failure`. An agent read that as done and the person's ask was silently lost. The save
  now records why it did not land, keyed by app and matched on the person's own words (the
  return leg `editIntents` already had), and the edit fails with that reason instead. The
  live trigger is a write-only refusal — chiefly the `assertCurrent` conflict when a skill's
  timer-save races an edit; a whole-store outage already self-reported through the read.

  The `.vendo` format reference promised it was taken from the parsers and then stated flatly
  that no `<Plan>` attribute but `name` is read, while `compilePlan` reads `display` and the
  `building-apps` skill on the same mount teaches `display="stage"` as load-bearing. A model
  that trusted the reference stripped it, and the app arrived as an inline card instead of a
  full-width stage. `display` is documented now, and the reference's own suite scans the
  compiler for the attributes it reads, so the next one fails the build until it is written
  down.

- 898eb8f: `@vendoai/apps` now ships its testing fixtures at the `./testing` subpath. The directory (`fake-sandbox`, `fake-box`, `scriptedLanguageModel`, `guardFixture`, `memoryStore`, and the rest) was already compiled into `dist/testing/` and already inside the published `dist` files-entry, but no `exports` key pointed at it, so it was dead weight in the tarball and unreachable to anyone — including this repo's own fixture suites, one of which carries the comment "the apps package's own test double is internal to that package" as the reason it hand-rolled a fortieth copy of a scripted model. Same posture as the `./adapter-conformance` subpath this package already publishes: testing material a host can use against the seams it implements. Purely additive — no existing subpath, type, or runtime behaviour changes.
- f25138f: `createApps` is an assembler now, not a 2,600-line function. Every private helper and every door it returned moved into a module beside its contract, each taking a `Pick` of the one shared closure type and returning its slice of `AppsRuntime` — the same shape the namespace surfaces already had. The public surface is unchanged: `@vendoai/apps` exports exactly what it exported, `runtime.ts` still re-exports every moved type and value, and no test changed. Pure refactor, no behaviour difference.
- 354f231: Remove undo and rollback entirely.

  **BREAKING, despite the patch version.** This release ships as a patch off the
  0.8 line (pre-1.0 convention), so the version number does NOT signal the removal
  below. If you call any export in the lists that follow, this release breaks your
  build — read them before upgrading. A `0.8.x` range accepts this version, so the
  version number alone will not hold it back.

  Two separate features, both cut: rolling an app back to a previous version, and
  walking a workspace file back to the version before its newest commit. **Users
  lose the ability to roll an app back.** That is deliberate. Pre-1.0, so this is
  a hard cut with no deprecation shim.

  Version history LISTING stays, everywhere: the app's capped 50-entry version log
  and the workspace's per-path revision trail are unchanged, and so is everything
  built on the recorded history — the review venue's newest-approved-version serve
  (`review.serveDocFor`), the pin-rebase replay trail (`history.pinIntents`), and
  the edit journal's append/discard/prune.

  Removed from `@vendoai/apps`:

  - `AppsRuntime.history(appId, ctx).undo()` — the surface now returns
    `{ list(): Promise<VersionEntry[]> }` only
  - `AppHistoryAccess.surface(appId).undo()` (the `createAppHistory` internal)

  Removed from `@vendoai/core`:

  - `StoreOps.workspace.undo(target, opts)`
  - `storeWireWorkspaceUndoRequestSchema`
  - the `"workspace.undo"` key from `STORE_WIRE_PATHS`, so the store wire is
    **31 doors, not 32** — `StoreWireStatus.ops` is now `31`, and the workspace
    family is 4 (index · read · commit · history)
  - the `workspace.undo` cases from the `storeOpsConformance` suite, and the
    `undo` implementation from `memoryStoreOps`

  Removed from `@vendoai/store`:

  - `workspaceStore(store).undo(caller, path)`
  - `WorkspaceRows.undo` and the `UndoOutcome` type (internal — never exported
    from the package index)
  - `createStoreOps(store).workspace.undo`, with its `pathsMovedOn`,
    `newestCommitTouching` and `commitCreated` helpers and the `created` array
    the commit ledger wrote for them
  - the `recordHistory` option on the internal write path, whose only `false`
    caller was undo — every landed write now records its superseded revision

  Removed from `@vendoai/ui`:

  - `VendoClient["apps"].undo(id)`
  - `useApp().history.undo()` — the hook's `history` is now `{ list() }`

  Removed from `@vendoai/vendo`:

  - the `POST /apps/:id/history` route (the `{ op: "undo" }` body). `GET
/apps/:id/history` is unchanged; the path now serves GET only
  - the `workspace.undo` leg of the hosted (Cloud) store adapter, which called
    the console's `POST /workspace/undo`

  **Existing data is left exactly where it is — no migration, no cleanup.**
  Existing `vendo_workspace_history` rows and `vendo:app-history:*` records stay
  readable by listing, but the content they hold becomes unrestorable: nothing
  reads it now. Those rows self-trim at `WORKSPACE_HISTORY_LIMIT` per path, except
  for a deleted path that is never written again, which holds its blob forever.
  That is a real consequence of removing the feature, and it is not repaired here.

- d599d23: `.vendo/tools.json` is the one source of truth for every tool's request and
  response schema, and the runtime sampler is gone.

  Sync fills both slots through a trust ladder and records which rung filled each
  one: the host's own spec (`declared`), its TypeScript types (`types`), the AI
  judge reading the handler (`inferred`), or nothing (`unknown`). The judge may
  only fill a slot nothing else could read — refused in code, not by prompt — and
  its fills survive the next sync through the same carry-over `semantics` uses.
  Coverage is reported plainly by `vendo sync`.

  Every prompt that lists tools now lists all of them: a tool with a declared
  schema shows its shape, and a tool with a blind slot says so in words. A blind
  input never prints as `{}`, which reads as "takes no arguments" — and a
  declared no-argument tool still prints the empty schema it really has.

  **Breaking, both pre-1.0:**

  - `AppsConfig.connectedToolkits` is removed from `@vendoai/apps`. Its only
    reader was the create-time shape sampler, which is deleted: nothing calls the
    host to learn a shape anymore. Drop the option; there is no replacement and
    nothing to migrate.
  - `deriveShapeCard`, `deriveShape`, `mergeShapes`, `ShapeCard` and
    `shapeCardSchema` are removed from `@vendoai/core`. Shapes come from declared
    JSON Schema now — use `shapeFromJsonSchema(schema)`, which additionally keeps
    `enum` values a sample always erased.

  A host that declares its response schemas gets strictly better checking and one
  fewer live call per create. A host that declares nothing keeps working: blind
  tools run permissively, and the report says which ones they are.

- a69aa5c: Delete the orphaned edit validator, and make `one-floor.test.ts` true again.

  `documentFromEdit`, `validateEditedApp` and their `issueLine` helper lost their
  only caller when "the brain dies" deleted `generation/conductor.ts`: an edit is
  the screen assembler rewriting the app's own `app.vendo` and saving it, so it is
  checked by the paint seam's floor and by nothing else. Nothing public changes —
  none of the three was exported from the package.

  `one-floor.test.ts` opened by claiming four doors "each through its own REAL
  entry point" and then drove its edit case through that orphan, so its edit-door
  proofs were proofs about a function nothing calls. It now drives three doors
  through `AppsRuntime.floor(ctx)`, `validate({ document })` and
  `validate({ appId })`, and says plainly that the edit path is the first of them.

  With the orphan goes its **carried-issue filter** — an edit was excused for an
  issue the previous version already carried. That rule was never re-implemented
  on this architecture and is not a behaviour production has: the floor runs on
  every commit for every author, and a block is a block.

- 7163a25: Every finished screen faces the AI reviewer, with the data it renders.

  A bills dashboard summed two overlapping query results into one headline: $11,216
  on screen over ~$6,276 of real bills (demo-bank, 2026-08-06). Every mechanical
  check passed, because a double count is not a shape error — the binding was well
  typed, the field existed, the tool was real. The reviewer is the only check that
  can see it, and it never ran: it fired only when the writing model volunteered to
  call `validate({appId})`, and that run did not.

  Two things change.

  **The reviewer is no longer optional.** It runs at both places a screen is
  finished — when the screen agent's assembly completes with a stored, painted app,
  and at the built path's turn boundary where the validate gate already runs. Its
  findings join the existing single repair round; there are no loops, and the
  reviewer's own fail-open posture is untouched — silence, a refusal and a failed
  request still all mean no findings, so a reviewer that could not judge never costs
  a person their screen. It is deliberately still absent from the paint seam, which
  runs on every save, and it is never spent on a document that did not pass the
  mechanical floor or never reached the screen.

  **The reviewer now sees the rows.** `validate({appId})` runs the app's own
  `<Query>` tools — read risk only, through the same guard-bound registry the screen
  itself reads from — and hands the results to the reviewer beside the printed
  markup. Its rubric gained one rule: check every total, count and average against
  those rows, including the overlap case where two queries return the same records
  and both get summed.

  The cost is exactly one reviewer model call per finished screen.

- 1022b2f: Every app-document read stops reinterpreting pre-split demo rows.

  `classifyLegacyPlacements` rewrote a stored `pins` entry whose `base` matched no
  captured baseline into `doc.placements` on the way out. It ran on ten read paths
  — `owned`, `list`, the files-first save, the review queue, the served snapshot,
  the venue-state re-read, the two approval surfaces, and inside both optimistic-
  concurrency `JSON.stringify` comparisons — so every reader of an app document had
  to know a shape only stale demo rows could have.

  Nothing produces that shape. The one writer was demo-bank's `/api/demo/pin`,
  deleted when placement became a first-class Vendo write; `pins.fork` and
  `pins.rebase` only ever record a captured baseline's own hash. Its output field
  is dead too: a placement is a `vendo_placements` row now, and no read mounts from
  `doc.placements`. For every row the runtime can write the shim was already the
  identity function, so no behaviour changes.

  A stored row still carrying the old shape now reads as what it says it is: a pin
  whose baseline is gone. It reports drift, it enters the ship diff, and it fails
  the export gate — instead of being silently reinterpreted.

- 2b6d60f: Remove the orphan wire text-edit surface and the inert reshape deprecation walker.

  `applyTextEdits`, `recompileWithIdentity`, `TextEdit` and `TextEditResult` are
  gone from `@vendoai/core`: the consumer was deleted when the conductor replaced
  the generation engine, and nothing has called them since. The four `<Edit>`
  patch issue codes they fed (`missing-edit`, `unknown-target`, `invalid-patch-op`,
  `patch-invalid`) go with them, and the two generation prompts stop teaching an
  `<Edit><Old><New>` dialect no parser reads — the "edit the text, never rewrite
  the file" rule stays.

  `findDeprecatedReshapeUsage` and its two orphaned constants
  (`DEPRECATED_RESHAPE_OPS`, `DEPRECATED_FORMAT_KINDS`) are also gone. The notices
  were never surfaced to anyone. The deprecated ops themselves keep compiling and
  rendering for stored apps exactly as before.

- b99147f: One component family: the legacy prewired set is retired, and the Kit is the
  only built-in vocabulary.

  Vendo shipped two component families that shadowed each other by name. The
  legacy prewired/branded set (`packages/ui/src/tree/{primitives,branded}.tsx`)
  won every name collision, so the Kit's `Stat` could never format a value, its
  `Text` was masked by a permissive one, and `DataTable`'s smart table sat behind
  a plain `Table`. That set is gone. One family now, declared once by
  `KIT_SPECS`, taught by `kitPrompt()`, resolved by the compiler, rendered by
  `KIT_COMPONENTS`, and validated from the same schemas.

  **Breaking — `@vendoai/ui/tree`.** These exports are removed: `Stack`, `Row`,
  `Grid`, `Text`, `Skeleton`, `Surface`, `Divider`, `Card`, `Button`, `Input`,
  `Select`, `Table`, `Badge`, `Stat`, `Tabs`, `PREWIRED_COMPONENTS`,
  `BRANDED_COMPONENTS`, and their prop types. Import the components from
  `@vendoai/ui/kit` instead — every name above except `Table` and `Skeleton`
  exists there with theme-token styling and real prop schemas.

  - **`Table` → `DataTable`.** The Kit table sorts, filters, searches,
    paginates, resolves dot-path column keys, and formats each cell. Its
    `columns` take `{key, label?, format?, align?}` objects rather than bare
    strings, `rows` is required, and `emptyLabel`/`rowKey` are `emptyState` and
    automatic respectively.
  - **`Skeleton` is no longer a component.** A loading placeholder is renderer
    chrome, not something a tree names, so it moved inside
    `tree/forming-skeleton.tsx` and off the public surface. It marks itself with
    `data-skeleton` (it was `data-primitive="Skeleton"`).
  - **`Tabs` keeps its tree contract.** The Kit `Tabs` now accepts the wire
    shape — string or `{value,label}` items, an initial `value`, and panels as
    CHILDREN in tab order — alongside its code-only `{label, content}` items.
    Tabbed apps are unaffected.
  - **`data-primitive` is gone.** Every built-in marks itself with `data-kit`;
    tests and styles selecting on `data-primitive` must be retargeted.

  **Reserved names now follow the Kit.** `RESERVED_COMPONENT_NAMES`,
  `BRANDED_COMPONENT_NAMES`, and `PREWIRED_COMPONENT_NAMES` are removed from
  `@vendoai/core`; `KIT_COMPONENT_NAMES` and `KIT_WIRE_COMPONENT_NAMES` replace
  them, so a generated component may not shadow any Kit name.

  Two schemas were widened where the retired family had been quietly absorbing
  real usage: `Text.text` takes `string | number` (matching its `ReactNode`
  implementation), and a single-segment `$state` read binds into any prop again
  while `state.key.deeper` stays a compile error.

  Stored apps naming `Table` or `Skeleton` render the contained
  "Unknown component" notice on that node while every sibling still renders.

- b99147f: One theme→CSS-variable mapping, owned by `@vendoai/core`.

  The same `VendoTheme` was flattened into `--vendo-*` custom properties in three
  places — the ui chrome, the MCP door's connect/consent pages, and the MCP Apps
  shim's `:root{}` block — each a hand-kept copy of the others, and they had
  drifted: the door emitted 16 of the 32 variables the chrome does, so a themed
  MCP page never saw `--vendo-color-scheme`, `--vendo-base-size`, the density
  sizing scale, or the motion timings. `defaultVendoTheme`, `resolveTheme`,
  `colorSchemeForBackground` and `themeCssVariables` now live in
  `@vendoai/core` (and are exported from it); `@vendoai/ui` re-exports them
  unchanged, and both MCP paths are a one-line serialization of the same call.
  `VENDO_THEME_VARIABLE_NAMES` is read off that mapping, so the generation
  prompt's brand-token line and the shim's reverse read cannot fall behind a
  rename.

  Two brand bugs fell out of the merge. The Kit's token fallbacks had `surface`
  and `background` swapped, so an unthemed Kit painted a white page with
  off-white cards inverted; its `fontFamily` fallback had also lost the Onest
  brand stack. Both now derive from `defaultVendoTheme` instead of being retyped.

  The phantom `--vendo-space-*` variables are gone. Nothing ever emitted them, so
  every reference rendered its fallback; the door pages, the Kit's `Stack`/`Row`
  gap, and the tree's notice and open-in-product card now use the real
  `--vendo-density-*` variables where the scale matches, and the literal
  elsewhere. Rendered output is unchanged.

- 5e8a141: A steered turn now ends when the engine says it is over, not when a guessed
  number of `result` messages have arrived.

  The live Claude session gave each steer one extra `result` to absorb, on the
  belief that every user message the engine answers produces exactly one. Nothing
  guarantees that — the engine's own docs describe a queued batch being "coalesced
  into one turn", which is also what steering is documented to do (the words reach
  the model at its next step boundary). One result short and the count swallowed
  the FINAL result too, so `send()` waited out the whole 15-minute message budget
  for work that had already finished. The count is now only a cap on the wait; the
  engine's `session_state_changed` → `idle`, which its own schema calls the
  "authoritative turn-over signal", is what ends the turn. The session asks for
  that event explicitly (`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`), and an engine
  that never sends it falls back to exactly the old behaviour.

- 8f3d23a: Box door: a session that fails to open now hands its in-flight slot back, so a
  box whose SDK import fails answers 500 once instead of 409 "a message is
  already running" forever.

  fn names: one bounded `[A-Za-z_][A-Za-z0-9_-]{0,63}` pattern instead of two that
  disagreed, so a long fn name no longer dispatches in-process while the HTTP wire
  route refuses it.

  Review queue: each app's rejection rows are paged once per queue build, not
  twice.

  Removed two surfaces with no callers: `explicitSamplingParams` /
  `SamplingRequest` (never on any export path) and `EgressApprovals.pending`.

- be9f3e9: The apps contract now sits beside its implementation.

  `createApps` was one 2,942-line closure, and the `AppsRuntime` interface it
  implements sat ~2,000 lines above it in the same file — so reading any single
  verb meant scrolling between two distant halves of `runtime.ts`. The contract and
  the shapes its verbs speak move to `types.ts`, and four of the nested namespaces
  (`access`, `inClient`, `review`, `pins`) each get their own module taking a small
  shared context, the same shape `interchange`/`history`/`review` already use.
  `pins` alone was 315 lines inline; its orchestration now lives in `pins-surface.ts`
  beside the pure logic that was always in `pins.ts`.

  Internal refactor only — the public surface is unchanged. Every type is still
  exported from `@vendoai/apps` and still re-exported from `./runtime.js`, no
  behaviour moved with the code, and the package's full suite passes untouched.

- 2b49b64: Three of this block's densest functions are decompositions now. The agent-tool registry's `execute` is a dispatcher: `vendo_make` and its two routes moved to `make-tool.ts`, the three `vendo_apps_data_*` doors to `data-tools.ts`, and the argument checks both share to `tool-args.ts`. `validatePlan` hands its steps rules to a `stepsIssues` collector beside the `scheduleIssues` one it already had, and the Claude session loop reads its `query()` options and its assistant-message scan from two named siblings — siblings, not modules, because `dist/claude-turn.js` is copied verbatim into the box image and has no relative imports to give them. No public surface changed, no behaviour changed, and no test changed.
- 6fb568a: Replace the RFC-6901 JSON Pointer writer in `open.ts` with a direct assignment
  under the query's name. The pointer was always `"/" + query.name`, and both
  producers of a query name (`validateTree` and the wire compiler) hold it to
  `/^[A-Za-z_][A-Za-z0-9_]*$/`, so no separator, escape or index could ever
  reach it. The prototype defence stays, as an own-property define — the same
  8-line shape `ui/src/tree/mcp-shim/shim-core.ts` already ships.
- Updated dependencies [a7a0fcf]
- Updated dependencies [e092567]
- Updated dependencies [b99147f]
- Updated dependencies [46923cc]
- Updated dependencies [b50a766]
- Updated dependencies [022f789]
- Updated dependencies [354f231]
- Updated dependencies [ee92750]
- Updated dependencies [d599d23]
- Updated dependencies [89660d1]
- Updated dependencies [2b6d60f]
- Updated dependencies [b99147f]
- Updated dependencies [b99147f]
- Updated dependencies [2357b22]
  - @vendoai/core@0.8.1

## 0.8.0

### Minor Changes

- 963d980: Agents can address a place on the page, and a slot tells the truth about what is in it.

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

- b022eb3: Lift the turn loop out of `createAgent`, and expose the cross-block seams behind
  `/internal`.

  `@vendoai/agent`'s inner loop is now its own module so a harness can DRIVE it
  instead of reimplementing it. Behaviour is unchanged — the package's own test
  suite is the specification for the lift and passes unmodified.

  - `loop.ts` owns the `streamText` call: the step cap, `buildFailedStop`, the
    history window, the Anthropic cache breakpoints, the abandoned-approval
    provider rewrite, the tool-search loadout, and the step-limit notice.
  - `wire-error.ts` owns `wireErrorMessage`, so a second caller raises the
    IDENTICAL failure affordance — banner, Retry, detail line, and the
    meter-exhausted sentence — rather than inventing a second error UX.
  - `tools.ts`'s guarded-call path and approval preview are reachable as
    `guardedCall(descriptor, options)` and `previewApproval(descriptor, options,
onAsk)`. Both are CURRIED so the ai-SDK still invokes the body directly: an
    extra microtask before an abort raised inside a tool changes whether a dangling
    `input-available` tool part reaches the transcript.

  **Host-facing surfaces are unchanged.** Everything above ships behind
  `@vendoai/agent/internal` and `@vendoai/apps/internal` — the idiom
  `@vendoai/core/conformance` already sets. The only supported consumer is another
  `@vendoai/*` block, so these stay free to change without a major bump:

  - `@vendoai/agent/internal`: `startTurn`, `providerHistory`, `turnModelMessages`,
    `DEFAULT_MAX_STEPS`, `wireErrorMessage`, `guardedCall`, `previewApproval`,
    `addAgentTool`, `buildAgentTools`, `createToolSearchSession`,
    `assembleSystemPrompt`, `validateUpsert`, `abandonPendingApprovals`,
    `guardApprovalIds`.
  - `@vendoai/apps/internal`: `assembleTree`, `stripServerAuthoritativeFields` —
    so the harness runtime's render seam emits the payload shape the shipped
    emitter emits instead of keeping a drifting copy.

- 1572060: An app's code reaches the store, so the box is disposable.

  `AppDocument.source` and the `checkoutApp`/`commitApp` seam landed with the
  contract but with ZERO production callers: every build still persisted code only
  into the sandbox snapshot behind `machine.snapshotRef`, so losing a snapshot lost
  the customer's app. This wires the commit half in.

  - `RenderSeamOptions.commitSource` is the sibling of `authoredApp` on the SAME
    interception point. `commit()` is the store-write moment, and the reason is the
    one already stated in `render-seam.ts`: the sandbox sync-back path commits
    without ever calling `writeFile` on this façade, so a builder working inside a
    box reaches the store here and nowhere else. It runs once per APP a commit
    touched, with `CommitResult.changed` verbatim; a `conflict` result persists
    nothing, because nothing landed.
  - `AppsRuntime.commitSource` is the store half, binding `commitApp` to the app
    row's ownership (§9.7 — the address comes from the owner, never from which
    mount happens to be writable), its compare-and-swap update, and — new —
    `AppsConfig.files`, the SAME `FilesAdapter` the workspace rows spill to.
  - The `HOT_PATH` regex became one `APP_PATH` regex with the filename as a tail,
    so "which app is this path in?" has one answer for the hot paths and the source
    tree alike. No second path reader.
  - Source persistence can never fail the commit it rides on, exactly as a view
    cannot — but a silently dropped source file is a lost app, so a failure is
    logged loudly rather than swallowed.

  `machine.snapshotRef` is now a cache in fact and not only in the doc comment: the
  audit found no reader of it anywhere that recovers source (`SandboxMachine` has no
  file-read method at all), and the new seam test deletes an app's snapshot, proves
  `resume` fails, and rebuilds the app from its row alone into a store that has
  never held its files — byte for byte, including a file past the inline cap so the
  blob-spill leg is proven too. `trigger`, `placements`, grants and the app's id all
  ride through untouched: a commit is not a generation.

  Two things that ride along, because this PR is `commitApp`'s first real caller and
  both only become reachable with one:

  - **`commitSource` is a new authorization surface, so it is tested hostilely.** The
    appId it writes to is derived from the COMMITTED PATHS, and a caller may write
    anything under their own `/user` mount — including another person's app
    directory. Three cases are now pinned: a foreign caller is refused and the
    refusal is AUDIBLE rather than a silent skip; an org-owned app resolves to its
    ORG address even when the caller's personal mount is writable too; and a commit
    naming a stranger's app alongside the caller's own lands nothing on the
    stranger's while still landing the caller's. All three pass against the gates
    Phase 0 already put in — these document them, they do not add them.
  - **"Would not read" is no longer treated as "was deleted."** `commitApp` decided
    deletions by whether the read-back threw, and for a spilled file that read is a
    live fetch from the files adapter — so a blob store having a bad minute looked
    exactly like a deletion and the entry was dropped. Now a path that still EXISTS
    but will not read keeps its stored entry and says so loudly; only a confirmed
    absence is a deletion. Per path, so the rest of the commit still lands.

- a004031: **BREAKING:** the bench host surface is removed from `@vendoai/apps` —
  `loadDemoBankCatalog`, `loadDemoBankTools`, and `demoBankToolShapes` are no
  longer exported. The `HostToolInfo` type stays.

  The W1-bench experiments those loaders served have concluded (verdicts:
  inline refs ADOPT; builder-calls, fetch-then-generate, CFG-JSX DEFER — the
  ledger lives in the private repo), and the loaders themselves could never have
  worked for an npm consumer: they resolved `examples/demo-bank/.vendo/*.json`
  relative to this repo's layout, so every call outside the monorepo threw. The
  one real caller (an internal bench harness, since moved out of this repo) now
  loads the catalog and tools locally.

- 21c8b10: **BREAKING:** the BYO schedule engine is gone — a machine app's `vendo.json`
  schedules are document triggers now, fired by the automations engine.

  `AppsRuntime.schedules` (its `tick`, `sync` and `report`) and the
  `SCHEDULE_STATE_COLLECTION` export are removed. `machine.syncManifest(appId, ctx)`
  folds a woken box's declared schedules into the app's document triggers and
  `machine.report()` says what happened, so last-fired state lives on the engine's
  per-trigger cursor instead of in a second `vendo_app_schedules` cache that a tick
  had to read to decide due-ness. A host that called `runtime.schedules.tick()` from
  its cron should call the one `/api/vendo/tick` door instead — it already drove the
  automation schedules, and it now drives these.

  Authoring changed in the same direction: the planner is never offered a tool whose
  unattended use is irreversible (the predicate is core's own
  `withheldFromUnattended`, the same one the run's projection uses, so authoring and
  firing cannot disagree), and an ask that needs one comes back as a sentence naming
  why and offering the away-safe half — read the live data, publish the result, and
  let the person do the irreversible part themselves. `planAutomation` is exported
  so a harness can author a plan without booting the generation pipeline.

- 1bb535b: The checks floor moves to the paint seam, and `instant()` is removed.

  ## BREAKING: `instant()` is gone

  `instant()`, `InstantHarnessDeps` and `InstantHarnessOptions` are removed from
  `@vendoai/harnesses` and from the `@vendoai/vendo/server` re-export. Two engines
  and no third: the lean `vendo()` loop, and the builder on the claude-code
  runtime.

  The specialist existed to put a layout on screen in seconds by routing an app ask
  straight at the guarded engine tool. The paint seam now does exactly that for
  **every** harness — a plan file renders its skeleton the moment it parses,
  whoever wrote it — so its whole reason for being was absorbed by the thing every
  thinker already rides.

  **If you had `harness: instant()`:** delete it. The slot's default is `vendo()`,
  which is the same guard, the same audit trail, the same view channel, and the
  same skeleton-in-seconds behaviour.

  ```diff
  - import { createVendo, instant } from "@vendoai/vendo/server";
  + import { createVendo } from "@vendoai/vendo/server";

    export const vendo = createVendo({
  -   harness: instant(),
      auth: { ... },
    });
  ```

  ## The checks floor runs on every commit, for every author

  The render seam compiled `app.vendo` with `compileWire(content)` and **no
  options**, so it spoke a different dialect than every other compile of model
  wire. Measured, both directions:

  - a lying binding — a `$path` naming a field the tool's response shape does not
    have — compiled to `issues: []` and `bindingErrors: []`. "The engine's
    unshippable gate" was structurally dead on the files-first path, and the app
    painted a label promising a number it could never show.
  - an app built on inline tool references had its binding **dropped** and its
    query never minted, and painted anyway, because the tree kept its children.

  So nothing checked a harness's own writes. The floor was live for the built-in
  conductor and structurally dead for every other author — a builder writing
  `app.vendo` with its own hands, a human with an editor.

  Now composition injects the floor into the seam (`RenderSeamOptions.floor`, built
  from the new `AppsRuntime.floor(ctx)`). Every commit to `app.vendo` compiles in
  the production dialect and runs the seven deterministic fact checks plus whatever
  the host plugged in through a pack. A blocking finding means the view does not
  paint — through the seam's existing "emits nothing, the last good view stays"
  mechanism, not a new failure channel — and the write still lands, so `validate`
  can read it back and repair it.

  Hosts need no code change for this: the seam is wired in composition.

  ## `validate` runs the whole floor, and the builder must pass it

  `AppsRuntime.validate` built its layer from `config.checks` alone, so it ran the
  fact checks and skipped the AI reviewer. The building-apps skill teaches
  "validate after every edit", and what it taught could not see invented data,
  dishonest tool use, dead controls, dropped work, or a single one of the host's
  own judgment **rules**. The reviewer is now composed in, fail-open as everywhere
  else: silence, a refusal, and a failed request all mean no findings.

  The claude-code harness's loop now requires it. After the turn's work reaches the
  store, the loop calls the same registered `validate` verb through
  `turn.tools.call` and, if an app document does not pass, hands the findings back
  for **one** bounded fix round. New exports for hosts driving their own harness
  loop: `validateWrittenApps`, `repairInstruction`, `VALIDATE_TOOL` from
  `@vendoai/harnesses`.

  ## `Finding` carries its check

  `Finding` gains an optional `check` naming the `Check` that produced it, stamped
  by the checking layer. Additive — existing readers are unaffected — but code that
  asserts exact `Finding` object equality will see the extra field. It makes
  architecture design §7's carve-out ("except host-check failures, which only the
  host can waive") representable for the first place: a built-in fact finding and a
  host's own plugged check were previously the same anonymous object.

  ## Also

  `@vendoai/core` gains the `AppFloor` port. The generation conductor is
  **quarantined** (`@deprecated`): its callers are frozen, not extended, and new
  work uses the lean loop with the floor at the seam.

- 10a2b44: `createVendo({ agent })` accepts a whole `@vendoai/agents` agent, and the sandbox
  ladder has one implementation.

  `createVendo`'s `agent` key is now a union: either the chat-context knobs it has
  always taken (now exported as `AgentOptions`) or the value `agent()` from
  `@vendoai/agents` returned. Handed an agent, the deployment adopts what that
  agent already composed — its harness, its store and blob adapter, its
  egress-skinned sandbox, and its `instructions` — so the embed's turns run on the
  same brain, the same transcript and the same box as `session.stream`. Passing any
  of `harness`, `store`, `files` or `sandbox` alongside an agent is a boot error
  naming each conflict, instead of one side silently losing.

  The guard and the host tool surface stay the deployment's: the embed's choke
  point carries org policy and app-tool risk grading, and its tools come from
  `.vendo/tools.json`. The agent's own guard and tools keep serving its `session()`
  calls.

  `VENDO_API_KEY` now fills an `agent()` sandbox slot the host left unset with the
  managed Cloud pool — importing `@vendoai/vendo` registers the Cloud rung the
  standalone runtime leaves open. An explicitly passed adapter still wins. The
  Cloud STORE rung stays open pending the tenant-store design, so an unset `store:`
  with only a Vendo key still refuses and names `store: postgres(url)`.

  `@vendoai/apps` gains the `./sandbox-ladder` subpath: `selectSandbox(configured,
cloudRung)` is now the ONE implementation of the adapter rule's sandbox ladder
  (explicit → `E2B_API_KEY` → the Cloud rung → nothing), shared by the umbrella and
  the standalone agent runtime. `SandboxVenue` moves there with it.

- 2722d81: The wire dialect becomes a strict TSX subset, with one call grammar.

  `compileWire` and `printWire` change surface syntax. A document already stored as
  a canonical tree is unaffected — the IR is untouched, `$reshape` still carries the
  same steps — but wire TEXT written against the old grammar no longer compiles,
  which is why this is a major bump.

  - **Reshapes are value-first nested calls.** `{revenue.rows | asPoints(month,
revenue)}` becomes `{asPoints(revenue.rows, "month", "revenue")}`, and a chain
    nests instead of piping: `rename(pick(q.rows, "month"), "month", "label")`.
    Reading the nesting from the inside out reads the steps in order. Field
    arguments are quoted strings; bare identifiers in argument position are gone.
    The printer emits chains inside-out under the unchanged byte-identical
    round-trip law, and it refuses to print a step no longer writable on the wire,
    falling back to the quoted object literal.
  - **Every aggregate names its field.** `sum(invoices.amount_cents)` becomes
    `sum(invoices.data, "amount_cents")`; `count(rows)` is unchanged. The implicit
    column read is gone from the call surface — an aggregate reads
    `rows.field` explicitly.
  - **`group_by` takes the rows it groups, plus a descriptor.**
    `group_by(rows, "issued_at", "month", sum.of("amount_cents"))` — arity 3 to 4.
    Because the rows are an argument, the old "aggregates the SAME rows it groups"
    inference retires with the grammar that needed it, and `count.of()` replaces
    `count(rows)` in the aggregate slot.
  - **Comments are JSX comments.** `{/* … */}` replaces `<!-- … -->`; the HTML form
    is no longer a comment.
  - **Braces in text are refused**, as the new `braces-in-text` issue code.
    `<Text>Total: {q.total}</Text>` rendered the braces literally; a value reaches
    the screen through a binding (`<Text text={q.total}/>`).

  **Two aggregate vocabularies collapse into one, and `avg` retires.** The dialect
  had a reshape `avg` and an expression `average` on the same surface, where the
  wrong one silently dropped the attribute. The surviving names are `sum, count,
average, min, max, difference, days_until, group_by`. `avg` is removed from
  `RESHAPE_OPS`; `sum`/`min`/`max`/`count` stay in the registry for STORED
  documents but are no longer writable on the wire, so exactly one `sum` is
  reachable. The numeric reduce behind both is now a single exported
  `reduceNumeric`.

  `WIRE_RESHAPE_OPS`, `isWireReshapeOp`, `reduceNumeric` and
  `AGGREGATE_DESCRIPTORS` are new exports; `EXPR_CALLS` is unchanged.

- 56e0cc3: **BREAKING:** escalation gets its receiving end, and both experimental flags are
  deleted. `apps.experimentalScreenAgent` and `apps.experimentalMachines` are gone
  from `createVendo()`; passing either is now a type error.

  **The screen agent is THE engine.** Every `vendo_make` ask starts in the cheap
  assembly loop on every deployment. There is no flag and no coin-flip. The
  conductor is unchanged and is still what an `unavailable` answer, a broken
  assembler, or an `assembled` that left no app row falls through to.

  **Machine-backed execution is gated by the sandbox adapter, and nothing else.**
  Configure `createVendo({ sandbox })` and layer-2 boxes are reachable; leave it
  out and they are not. Presence IS the deliberate opt-in — no capability boolean
  beside it. Every read site moved: the box lane in `laneGates`, the box seam
  inside the generation pipeline, and `apps.machine.provision`, whose refusal now
  names the missing sandbox instead of a flag. Layer 3 is unchanged: a narrowing
  of layer 2 that additionally needs the mounted wire and `VENDO_BASE_URL`.

  **`escalate` now lands somewhere.** It used to fall through to the conductor with
  the plan discarded — which meant the person watched a skeleton, then watched an
  unrelated app replace it. Two answers now, and the deployment's own shape picks
  which:

  - **A sandbox is configured** → the build runs. The same `create` a
    server-needing ask has always taken, at the SAME app id, so the plan's skeleton
    and the finished app share one stream and the outline becomes the app in place.
  - **No sandbox** → a `failed` receipt whose `say` names the capability gap in the
    person's own terms. Not a fall-through: the conductor is assembly too, so it
    cannot serve what assembly just escalated, and trying would spend a whole
    build's latency to arrive at a worse version of the screen already on screen.
    The still-forming card is unmounted by the UI once the turn is over, so the
    receipt is the last word rather than a permanent shimmer.

  **The build anchors on the escalated plan.** `AppsRuntime.create` takes an
  additive `plan?: string` — the ask still travels verbatim and the plan rides
  beside it as the brief, so the brain builds the outline the person is watching
  rather than re-answering the ask from scratch. The plan is read back out of the
  app's workspace through a new adapter slot, `AppsConfig.escalatedPlan`, filled by
  composition for the same reason `AppsConfig.screen` is: `@vendoai/apps` holds no
  workspace. Unfilled, the build plans from the ask exactly as before.

  Additive surface: `AppsRuntime.machine.available()` (is a sandbox configured),
  and `escalatedPlanPath(appId)` from `@vendoai/harnesses` so the writing and the
  reading side cannot spell the plan's path two ways.

  **Migration:** delete `apps: { experimentalScreenAgent: true }` — it is the
  default now. Delete `apps: { experimentalMachines: true }` — if the deployment
  already passes a `sandbox`, machines stay on with no further change; if it does
  not, machines were never reachable anyway.

- a004031: **BREAKING:** the `apps.fillConcurrency` config knob is removed —
  `createVendo({ apps: { fillConcurrency } })`, `AppsConfig.fillConcurrency`,
  and `ConductorOptions.fillConcurrency` are gone.

  Nothing ever set it: not the umbrella's own composition, not a demo, not a
  doc beyond the config listing, so every fill has always run at the built-in
  default of 2 groups at a time and still does. `fillPlan`'s own `concurrency`
  option (the internal dial the fill tests exercise) is unchanged; only the
  never-wired public spelling is removed. A host that passes it will now get a
  type error — delete the key, the behavior is identical.

- fbf265b: One front door: `vendo_make` replaces `vendo_apps_create` and `vendo_apps_edit`,
  and it hands back words instead of the app.

  **Breaking.** `vendo_apps_create` and `vendo_apps_edit` no longer exist. In their
  place is one tool with three parameters:

  ```ts
  {
    request: string,   // the ask, in the calling agent's own words — required
    app?: string,      // an existing AppId, to change that one specifically
    context?: string,  // free-text background, for callers whose conversation we cannot see
  }
  ```

  Two tools meant every calling agent — ours, a host's own AI SDK or Mastra agent,
  an outside agent over MCP — had to decide "new or change?" before it could ask,
  and get it right. That was never their decision: the seam knows whether an app
  exists, and a caller that wants a specific one says so with `app`. `context`
  exists because an outside agent's transcript is not ours to read; on our own
  doors the runtime's transcript stays authoritative and `context` is supplemental.

  **Also breaking: the tool returns a receipt, not the document.**

  ```ts
  interface MakeReceipt {
    id: AppId;
    title: string;
    status: "ready" | "building" | "failed";
    say: string; // ONE speakable line, consumer voice
  }
  ```

  The old tools returned the entire `AppDocument` — the tree, the island sources,
  the storage declarations, the machine reference. So a model was handed UI and
  trusted not to describe it, retell it, or invent from it. A model handed a tree
  eventually talks about the tree. Screens go server → slot; the agent only ever
  gets words, and `say` is the line it can utter verbatim. `status: "building"` is
  the honest answer while work continues.

  Two things follow from the receipt, and both are improvements rather than
  compromises. The automation card is now PUBLISHED by the apps runtime through the
  existing view-stream seam instead of being reconstructed at the agent bridge out
  of the edit tool's return value — one less part read by shape (01-core §16's own
  anti-smuggling rule, which that reconstruction was the exception to). And
  `instant()` now speaks the receipt's `say` rather than a canned "Updated.",
  which fixes a real mis-speak: a rejected change comes back OK, so the canned line
  claimed success for work that did not happen.

  **Migrating.** If you call the tool by name from your own agent, rename it and
  rename `prompt` → `request` and `appId` → `app`; drop `instruction` into
  `request`. If you read fields off its result, read `id` and `title` off the
  receipt and say `say`. If you had a policy rule or an override matching
  `vendo_apps_create` / `vendo_apps_edit` / `vendo_apps_*` for the build tools,
  match `vendo_make` — it deliberately sits OUTSIDE the `vendo_apps_` prefix,
  because it is the front door rather than a member of the runtime's family. Core
  exports `isVendoAppsTool(name)` for anything that needs to recognise both.

  Everything else about the call is unchanged: risk grade `read` (actions inside
  the screen are still graded and consented individually at call time), the view
  channel, the build-failed banner, and the transcript's build card.

- ce98c54: One validation floor at every door, and a host's declared tool schemas finally
  reach the screen type check.

  Four doors let an app reach a screen — the paint seam, `validate({ document })`,
  `validate({ appId })` and the edit path — and each ran a different subset of the
  checks, so an app refused at one shipped through another. An island that crashes
  the moment it renders was caught at exactly one of them. All four now compose
  the same `floorChecks`: the fact checks, the compiler static half, and the island
  gates (admission plus the smoke render). The AI reviewer has not moved — it still
  runs only where it ran before, at `validate`, because it spends a model call.

  The island gates move from `generation/validation/` into `checking/`, where the
  floor that runs them lives; the generation pipeline imports them from there. On
  the paint hot path a repeated save costs ~3ms more, because the smoke render is
  keyed on island source and an unchanged island never renders twice.

  `screenTypings` has always preferred a tool's DECLARED `outputSchema` over the
  shape sampled from one live call, and nothing ever populated it. It does now, so
  a screen is type-checked against the host's own contract. Sampling erases what a
  declaration keeps: an enum field samples as a bare `string`, so a host component
  whose prop takes that enum could never be satisfied by any tool — demo-bank's
  `MapleSpendingDonut` against `host_getSpendingInsights` was blocked at the checks
  floor on a screen that was correct.

- d0c3cc9: Risk grading stops guessing from tool names, and a tool nobody has graded now
  says so out loud instead of running.

  **The word lists are gone.** Extraction used to read a tool's name against
  `DESTRUCTIVE_WORDS` / `READ_WORDS` (and Composio slug verbs) to pick a grade.
  English is infinite, so that list was guaranteed to miss — _pay, charge,
  refund, approve, merge, publish_ were never on it — and its existence is what
  stopped anyone from auditing the labels. No code path concludes anything from
  a tool's name anymore.

  **Only facts grade a tool**, in priority order: a human (`overrides.json`), the
  AI judge (which reads the handler source and quotes its evidence), then
  protocol facts that are true by definition — HTTP `DELETE` is `destructive`, a
  declared GraphQL/tRPC `mutation` is at least `write`, and Composio's own
  `destructiveHint`/`readOnlyHint` say what they say. A `GET` is **not** a fact
  about reading (GETs that mutate exist) and a `POST` is not a fact about
  writing (search endpoints post).

  **⚠️ Breaking behavior: an unjudged catalog now asks on mutations.** Anything
  nothing above graded is the new first-class `ungraded` risk state, and the
  guard's default treatment is to ask — like `destructive`, and at the guard
  level rather than as an init-written rule, so a hand-wired server with no
  policy config at all gets it too. On an install that never ran the AI judge
  this is a real change: tools that used to run silently now park on an approval.
  That is the point — `payInvoice` classified `write` and ran un-gated. Three
  ways forward, and every one of them is a sentence:

  - run `vendo sync` with a model key so the judge grades the catalog;
  - grade the tools you care about by hand in `.vendo/overrides.json`;
  - or decide, in writing, that you accept them:
    `{ "match": { "risk": "ungraded" }, "action": "run" }`.

  `vendo doctor` reports the count plainly (`catalog: 34/61 tools ungraded`,
  code `E-TOOLS-003`), and a keyless `vendo init`/`vendo sync` says what the
  consequence is instead of implying the grades are real.

  **`critical` is now `confirmEach`.** Behavior is unchanged — checked before
  rules, grants, and the judge; none of them can suppress it; every call earns
  its own input-bound, single-use approval. The old name read as a severity rung
  and it is not one: the grade is a _fact_ about the action (a payment is a
  `write`), while `confirmEach` is _governance_ — who must be present. They are
  orthogonal, which is why a data export can be `read` + `confirmEach` and a bulk
  archive can be `destructive` without it. Host-authored files
  (`overrides.json`, `judgments.json`, `.vendo/tools.json`) accept `critical:` as
  a read alias indefinitely; every writer emits `confirmEach`. In TypeScript,
  `ToolDescriptor.critical` becomes `ToolDescriptor.confirmEach` and
  `decidedBy: "critical"` becomes `decidedBy: "confirmEach"`.

  **A standing denial means a person said no.** An ask that re-issues the same
  call id is answered by the user's earlier no instead of minting a new card — but
  only when a _human_ wrote it: an abandoned chat turn, a timed-out embed, and the
  TTL sweep reap the pending row and let the next issue ask again. A person's no
  also voids any unconsumed yes still sitting on the same call, and a decision can
  be taken back with `guard.approvals.revoke(id, principal)` / `DELETE
/approvals/:id` (the mirror of `grants.revoke`). Taking a decision back and
  replaying an approval are the same one-time transition, so a call can never both
  run and be voided — a take-back that arrives after the call was already
  authorized answers `conflict` rather than reporting success. `Guard` grows one
  optional method for the block that spends a yes WITHOUT replaying its call
  (automations arms a standing grant from it): `spendApproval(id, principal)`
  contends on that same transition and answers `spent` / `already-spent` /
  `taken-back`. Custom Guards are unaffected — callers feature-detect it, exactly
  like `abandonApprovals`.

  Three known limits, all written down at the code that carries them. The receipt
  is the only atomic step: an approval ROW has no guarded write (the store offers
  `atomic` for threads, apps and generic rows only), so every marker on it is a
  read followed by a write and something can move the row in between. Because the
  transition winner is settled before any row write, the worst that costs you is a
  stale marker — never an execution, since the transition a call would need is
  already spent. And a custom `Guard` that does not implement the optional
  `spendApproval` puts the automations grant mint back on that read-then-write
  footing, where a revoke landing in the window can lose to the mint; the guard
  that ships here has the seam. Third: when an automation's parked run resumes, its
  standing grant is written just before the call and taken back if the call is not
  authorized after all — every outcome the process lives through, a thrown one
  included, but a hard kill in between leaves that grant behind and nothing sweeps
  it. It shows up in `grants.list`, pinned to the tool's `descriptorHash`,
  app-bound and away-only, and you can revoke it.

  One consequence worth knowing: `descriptorHash` follows the field rename, so
  approvals and grants persisted before the upgrade no longer match their tool's
  new hash. They lapse into a re-ask, which is the fail-closed direction.

- 0197470: Reading a file off a sandbox is part of the seam, not each adapter's private
  business.

  `SandboxMachine.files` — `read`, `write`, `list` — is now declared on the public
  interface in `@vendoai/apps`. It already existed three times with an identical
  shape, hidden behind `satisfies SandboxMachine & Record<string, unknown> as
SandboxMachine` casts in the e2b and Vendo Cloud adapters and on the fake, and
  was missing entirely from two other test doubles: five private spellings (or
  absences) of one contract, on the seam a built app's SOURCE has to cross.

  The interface now states the answers all of them have to agree on:

  - `read` REJECTS for a path the box does not hold — never empty bytes, because a
    silently empty source file is a lost app.
  - `write` creates or replaces the whole file and creates the directories on the
    way to it. It never appends.
  - `list` is ONE level and names only: entries directly in `dir`, a subdirectory
    as its own name, never a path and never recursive. It rejects for a directory
    the box does not hold, exactly as `read` does.
  - `read` hands bytes back UNCHANGED — no text decode, no BOM strip, no
    line-ending normalization — because box content is untrusted and the layer
    above verifies it against the hash in the app's row.

  The shared conformance suite (`@vendoai/apps/adapter-conformance`) pins all of
  it in one leg that every adapter runs, so no provider can drift. Verified live
  against a real e2b sandbox, including a payload of NULs, bare CRs and invalid
  UTF-8.

  The consolidation paid for itself immediately: a review found that the
  in-memory `list` treated the root's prefix as `""` rather than `"/"`, so it
  sliced nothing off an absolute path and dropped every name as blank — `list("/")`
  answered `[]` on a box full of files. Before `inMemoryBoxFiles` that line existed
  in every fake that had a `list` and would have been a separate fix in each. It
  was one fix in one file, and the conformance suite now pins the root case for
  every implementation.

  Two further disagreements the promotion exposed, both invisible while `files` was
  private: the Vendo Cloud list route answers deeper than one level, so the Cloud
  adapter folds the depth away at the seam; and a missing directory rejected on
  real e2b (`[not_found] lstat …`) while both in-memory fakes answered `[]`,
  which is how a mistyped source directory reads as an app with no files. The
  seam now rejects everywhere.

  What went away: two redundant `files` casts on the real adapters, the
  `files`-shaped half of the Cloud wire test's private-surface cast, the
  `files` cast in three live bootstraps, and three copies of the fakes'
  in-memory file semantics (now one `inMemoryBoxFiles`). `SandboxMachineLike` in
  `@vendoai/harnesses/claude-code` carries `files`, still structurally and
  without widening the subpath's imports. `exec` stays adapter-private.

- 798b618: The screen agent: `vendo_make` starts in a cheap assembly loop, and the conductor
  is what it falls through to.

  Every request for something to look at used to go straight into the generation
  conductor — a plan call, a fill worker per group, and the checking layer's two fix
  rounds — whether the ask was a full app or one number on a card. Now the seam
  routes: a lean loop assembles the document itself, and escalates when it cannot.

  **The loop** (`screenAgent()` / `assembleScreen` in `@vendoai/harnesses`) is the
  same `startTurn` call `vendo()` and `instant()` drive, with a small loadout and a
  tight budget:

  - **Assembly tools only.** The verbs by name (`search_components`, `validate`,
    `vendo_apps_data_list`, `vendo_apps_open`, `ask_user`) unioned with the host's
    `read`-risk tools. No mutating host tool, no build tool, and `vendo_make` itself
    is withheld — the screen agent is what it calls.
  - **The host's own declared result shapes** ride the brief, off
    `ToolListing.outputSchema`, so field names are known before any query runs.
  - **The shipped job description**, reused: `buildingAppsSkill` and its
    `references/format.md`, plus one short block correcting what is different here
    (no disk, no delegation, two files, one door out). There is no third prompt.
  - **`SCREEN_STEPS = 10`.** An ask that needs more than that is an ask for a build.
  - **No new write path and no new paint path.** It writes `app.vendo` through the
    workspace and the render seam's `commit()` proxy paints it, exactly as the
    `claudeCode()` harness already builds apps.

  **Escalation** (`escalate`) writes `plan.vendo` and hands the ask on. The plan's
  skeleton paints in seconds and becomes the build's first frame — no consent step,
  one plain sentence, the work proceeds. `AppsRuntime.create` now accepts a
  caller-minted `appId` so the escalated plan and the build that finishes it land on
  one app and one view stream instead of two.

  **The routing is an adapter slot, and it is default-safe.** `AppsConfig.screen`
  takes core's new `ScreenAssembler`; composition is the only place that fills it
  (`apps.experimentalScreenAgent: true`, host config only). `vendo_make` falls
  through to `conductCreate` unchanged on every other answer — an escalation, an
  assembler that could not run, one that threw, and an `assembled` that left no app
  row behind. That last check is what makes the promise true rather than intended:
  the row is the truth, so a screen agent that saved bytes nobody can render costs a
  request nothing.

  Screens run unsandboxed, by design: a description is data, its props are
  schema-validated, and the kit treats them as inert.

  New in `@vendoai/core`: `ScreenAssembler`, `ScreenRequest`, `ScreenOutcome`.
  Edits go through the conductor as before — routing them needs the app's checkout
  projection, which is not this change.

- 8132329: A served app is reached through one checked door, and `experimentalServedApps` is
  gone.

  **The flip.** `open()` on a served (layer-3) app answered the OWNER with the
  sandbox provider's raw public ingress URL, and only a non-owner with this
  deployment's authenticated proxy URL. That owner URL is a bearer-by-obscurity
  capability: it carries no per-request check, so it keeps working for anyone it
  reaches — a shared screen, a copied link, a log line, a pasted bug report — and it
  outlives the grant, the revoke, and the app. Every served app is now answered with
  the proxy URL, which re-checks `can(viewer)` against live rows on every request
  and wakes the machine only after that check passes. The provider-URL leg is
  deleted, not left standing: there is no second way to reach a served app.

  Theme parity is kept — the proxy forwards `?vendoTheme=` into the box, so a served
  app renders in the host's brand exactly as before.

  **BREAKING: `AppsConfig.experimentalServedApps` and `apps.experimentalServedApps`
  are removed.** Layer 3 was never a capability a flag could grant on its own: it is
  a narrowing of layer 2. Delete the option — a host that passes it now fails to
  typecheck. `experimentalMachines` is unchanged and still required.

  What gates a served app instead, all of it already load-bearing:

  - **A machine to serve it.** `served` is derived as a narrowing of `box` in
    `laneGates`, so no sandbox or no `experimentalMachines` means no served lane —
    the relationship is the shape of the expression rather than two flags that have
    to agree with each other at composition time.
  - **A door to serve it through.** `laneGates` also requires `servedProxyPath`, so
    a deployment whose wire is not mounted hears "this host cannot serve its own web
    pages for an app" as a plain `<Cannot>` line in the plan, before a machine is
    built and a surface flipped to something no caller can open. The umbrella fills
    that seam from its own base path, so a `createVendo()` host has it already.
  - **An absolute origin.** The proxy URL must be absolute for a caller that is not
    already on this origin, so serving an app needs `VENDO_BASE_URL` — the same
    variable machine provisioning already requires.
  - **The surface flip's own two signals**, untouched: the plan asked to be served,
    and the host itself fetched `GET /` and got a real page. A box that self-declares
    a served surface on a layer-2 plan is still refused, loudly, and the tree keeps
    serving.
  - **Permission, first.** `edit()` on a served app no longer carries a flag
    refusal; what comes first is `can(editor)`, and an already-provisioned machine is
    never gated by the layer-2 flag — only new graduation and provisioning are.

  Removed with it: `servedAppsDisabledError`, the `servedThroughProxy` predicate
  (and the duplicate access read it did behind `open()`'s own check), the
  `ServedSurface.enabled` mirror, and the composition-time
  `experimentalServedApps requires experimentalMachines` refusal — six concepts out,
  one expression in.

- 14e8246: A team-shared file now reaches the `claudeCode()` sandbox — and its edits come home.

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

- 6a3d9e3: refactor(apps)!: the brain dies — one router, one builder, zero middlemen

  `AppsRuntime.create` and `AppsRuntime.edit` no longer run a generation pipeline.
  They run the SAME engine `vendo_make` runs: the screen assembler in the
  `apps.screen` slot. "The seam routes, not the caller" was never a `vendo_make`
  property — it is the runtime's, and now every caller behind it (the HTTP wire,
  the React client, a seed script) gets it.

  - **`create`** asks the assembler first. `assembled` → the row it stored is the
    answer. `escalate` → the plan it wrote is the build's whole brief.
    `unavailable`, a throw, or an unfilled slot → an honest failure that says so.
  - **`edit`** is the assembler opening the app's own `app.vendo`, rewriting it and
    saving it; the save lands through `AppsRuntime.authored`, so the store write,
    the checks floor and the paint are the shipped ones. An `escalate` on an
    existing app is the escalation ladder — an automation, or a box.
  - **The machine lane briefs itself from the plan.** `<Server kind="steps" |
"agentic" | "box" [served]>` is the escalating agent's own declaration and
    nothing re-derives it; a plan that escalated with no `<Server>` defaults to
    `kind="box"`, because the escalation is itself the claim that assembly cannot
    serve the ask. The in-box task carries the plan text verbatim, the person's ask
    verbatim, and the app's memory.

  ## Breaking

  - **`apps.fill` (`{ model }`) is gone**, and so is the fast fill tier it named:
    the group fill workers it pointed at do not exist any more. `createVendo`'s
    `models.fill` seat (and its deprecated `paint.model` predecessor) are still
    accepted and validated, and are now **ignored** — nothing reads them — so a host
    config does not have to change in the same release. **Migration:** delete
    `apps: { fill: … }` from a direct `createApps(...)` composition, and drop
    `models.fill` / `paint` from `createVendo(...)` at your convenience. Nothing
    replaces them: there is one generation seat (`apps.model` / `models.default`),
    plus whatever the assembler's own harness uses.
  - **`apps.screen` is required for `create` and `edit`, not only for `vendo_make`.**
    A deployment that composes `@vendoai/apps` without a `ScreenAssembler` now fails
    those doors loudly instead of quietly serving them from a second engine.
    `createVendo` fills the slot for you.
  - `UNSTORED_APP_ID` is no longer exported from `@vendoai/apps`.
  - An app row's `session` (the brain's transcript) is no longer written or read.
    Existing rows are unaffected until their next write, which drops it. An app's
    memory (`remember`) is what carries intent forward.

  ## Deleted

  `generation/conductor.ts`, `generation/brain.ts`, `generation/fill.ts`,
  `generation/prompts/`, `generation/contracts/sections.ts`, the island lane and
  `laneGates` in `generation/lanes.ts`, `growSkeleton` / `spliceFragment` /
  `Skeleton.slots`, `FIX_ROUNDS`, the commit-gate lead paragraphs, and the session
  plumbing. `skeletonFromPlan` stays — it is the live plan-paint path at the render
  seam.

- fbf265b: A turn, a beat and a screen each say what they are — plus an app's code moves
  into its row.

  **`Turn.turnId`, and every audit row carries it.** There was no turn id anywhere,
  so an audit row, a mirrored tool call and a painted view could not be joined to
  the exchange they came out of. "Which calls belonged to the turn where the user
  asked for X" was unanswerable from the audit plane — the plane billing and
  reconciliation read. `mintTurnId()` mints `"trn_<32 hex>"`, the runtime stamps it
  where it already builds the `Turn`, and it rides the `RunContext` from that line
  on, so every guarded call, audit row and painted view downstream is joinable
  without a new parameter on fifteen signatures. Opaque to adapters. Additive for
  hosts: `RunContext.turnId` and `AuditEvent.turnId` are optional, and absent means
  "no turn", never "unknown turn".

  **Beats.** `HarnessEvent`'s `status` member gains an optional `phase`
  (`"understanding" | "planning" | "assembling" | "building" | "checking" |
"finishing"` — closed at six) and an optional `appId`. The union itself stays
  closed at four members, because adding one is a breaking change for every host
  renderer and widening one is not. A harness that yields only `label` puts the
  identical transient `data-vendo-status` chunk on the wire it always did.

  **`ScreenDescription`.** The view channel carried `UIPayload` —
  `{ formatVersion: string; [key: string]: unknown }` — an open bag whose seven real
  fields were read by inline cast at each consumer, so a deployed host frontend had
  nothing to hold us to. The fields are now declared and versioned, and the render
  seam GATES on them: what it compiles must parse or nothing paints, which is the
  law that seam already lived by for content that does not compile. The schema
  refuses `data` outright — a description says what to fetch, never what came back
  — so that law is enforceable rather than written down.

  **`AppDocument.source`.** An app's code had three homes: island TSX in
  `components`, the wire surface in workspace file rows, and — for a served app —
  only inside the sandbox snapshot behind `machine.snapshotRef`. Lose the snapshot
  and the customer's app was gone, because the store never had it. `source` maps
  POSIX-relative paths to `AppSourceFile { hash, bytes, text?, blobRef? }`, inline
  up to `WORKSPACE_INLINE_MAX_BYTES` (which moves to `@vendoai/core`, where its two
  readers can both see one answer) and blob-spilled past it through the SAME
  `FilesAdapter` the workspace rows already spill to. `machine.snapshotRef` becomes
  a cache: an app can always be rebuilt from its row.

  `checkoutApp` / `commitApp` in `@vendoai/apps` make a workspace a working copy of
  that row — checkout projects the document onto a filesystem, commit diffs the
  changed paths back. The two hot paths (`app.vendo`, `plan.vendo`) stay the render
  seam's, `trigger` travels untouched through every path, and a source key that
  would escape the app's directory is refused by the document validator.

  All additive for hosts: every new field is optional, every schema stays
  `.passthrough()`, and rows written before this keep parsing unchanged.

- 38a840d: `vendo_make` has ONE engine. Assembly that produces no screen is the answer.

  `ScreenOutcome.unavailable` used to fall through to the conductor, and so did an
  unwired assembler, an assembler that threw, and an `assembled` that left no app
  row behind. All four now end the ask with a FAILED `MakeReceipt` whose `say`
  names what happened — the assembler's own `why` verbatim where there is one.

  A quiet fall-through is how a composition bug ships: a deployment that forgot to
  fill `apps.screen`, or whose assembler is broken, read all-green while every ask
  was served by an engine nobody chose. It reads as broken now.

  `escalate` is unchanged — it is a request for the builder, not the seam failing,
  and a deployment with a sandbox still runs the build at the same app id.

  **Migration**

  - **`apps.screen` is required for `vendo_make`.** `createVendo()` fills it; a host
    composing `@vendoai/apps` directly must pass a `ScreenAssembler` or `vendo_make`
    will answer `status: "failed"` on every new-app request. `AppsRuntime.create`
    and `AppsRuntime.edit` are unaffected and still generate.
  - **`conductCreate`, `conductEdit`, `ConductedApp`, `ConductedResult` and
    `ConductorOptions` are no longer exported from `@vendoai/apps`.** They were
    public for "external bench harnesses"; a reverse-dependency walk found no
    caller in this repo, the examples, the corpus harness or the docs. The pipeline
    still runs inside `createApps()` — it just has no public surface to be extended
    through.
  - `generationPromptSections` (internal, `generation/contracts/sections.ts`) is
    deleted: no caller, and a second unmaintained description of the v2 tree
    contract is worse than none.

- a0dbfc6: The agent can now be told who the user is and what they are looking at.

  Two seams, both optional, both merged into one `[Situation]` block on every
  message the user sends:

  - **User facts.** The `user` resolver on the `authJs()` and `jwt()` auth presets
    may now return a `facts` object alongside the principal, and those facts reach
    the prompt. The session is decoded once per request for both the principal and
    the facts. An anonymous request resolves no facts.
  - **Live screen context.** `useVendoContext(data)` publishes structured host data
    for as long as the component is mounted, and retires it on unmount. Several
    mounted callers coexist and merge. `VendoProvider` also takes `captureScreen`
    (default `true`) to control the screen snapshot that rides the same channel.

  **BREAKING (`@vendoai/ui`, `@vendoai/vendo/react`): `useVendoContext` is now
  `useVendoProvider`.** The name `useVendoContext` previously belonged to the
  zero-argument hook that read everything `VendoProvider` supplies; it now belongs
  to the host-facing hook above, which takes data and returns nothing. Both names
  still exist, so the compiler is the thing that catches this:

  ```diff
  - const { client } = useVendoContext();
  + const { client } = useVendoProvider();
  ```

  Because both names still exist, the compiler catches this rather than the
  runtime: an existing zero-argument call now fails with `TS2554: Expected 1
arguments, but got 0`. Rename the call and you are done — nothing else about the
  provider value changed.

- 39a7ecc: **Both writers get a design brief.** The screen agent and the `claudeCode()`
  builder could name every component in the catalog and had nothing to say about
  WHICH one, HOW MANY, or WHERE — so a screen was whatever the model reached for
  first.

  **The design law ships inside the skill.** `buildingAppsSkill` gains a
  `## What a good screen looks like` section, written in `.vendo` terms rather than
  CSS, because every one of these is a choice made in the plan: lead with the
  answer, fewer parts and better ones, never say the same thing twice, bind the
  rows as they come, group by what the person came to do, `col` is width and never
  slicing, pick the chart by the shape of the data, a hole is a `<Cannot>`, the
  words are the host's own, and an `<Island>` styles with the theme's CSS variables
  and nothing else. One text, in the skill BOTH writers read, so `claudeCode()` and
  the screen agent cannot be taught different design.

  **The host's theme and design rules now reach both writers.** `apps.designRules`
  and the theme tokens are documented seams a host sets and expects to be obeyed.
  They reached the fill worker of the retired conductor and nothing else — so on
  both live write paths those two config keys silently did nothing. The new
  `hostDesignBrief` (exported from `@vendoai/apps`) renders that pair ONCE, and
  composition hands the same string to both seams: the screen agent's brief,
  through a `design` slot beside `system` on `ScreenInput` and
  `ScreenAssemblerDeps`, and the composed prompt `claudeCode()` thinks with. The
  slot is a thunk, not a value, so a rules change applies to the next screen rather
  than the next boot.

  Deliberately NOT inside `claudeCode()`: that harness thinks with `turn.system`
  whole and alone and appends nothing after the host's prompt seam, so the prompt
  seam is the only honest place for them.

### Patch Changes

- 2e792a1: Advisory compile issues are advisory at every validation door.

  #906 put ONE floor behind the four doors an app reaches a screen through, but the
  compile issues in FRONT of that floor were still classified twice. The paint seam
  refuses only what did not parse — `compile-failed`, `missing-app` — while
  `validateCompiledCreate` turned EVERY wire issue into a block.

  They disagreed on `wire-id-ignored`, which is not a code a model has to invent:
  `checkoutApp` writes an app's own `app.vendo` with
  `printWire(…, { includeIds: true })`, so every element of a checked-out app carries
  an id the compiler then ignores. The seam painted those bytes and
  `validate({ document })` refused them — the door the assembly loop is told to call
  "the floor" answering "does not pass" over our own printer's output. PR #913
  measured it and deliberately left it.

  Core now names the one classification the doors share
  (`isAdvisoryWireIssue` / `WIRE_ADVISORY_ISSUE_CODES`), and the create and edit
  validators read it instead of blocking on every issue. Nothing else moves: an
  issue that drops something the author actually wrote still blocks everywhere, and
  the paint seam's own parse gate is untouched.

- 3f98372: **Apps remember what they were asked for.** A screen or build run is stateless,
  so the ARTIFACT now carries its own context: `AppDocument` gains an additive
  `memory` of two parts.

  - **`asks`** — every `vendo_make` request that touched this app, VERBATIM and in
    order, the create ask first. Never a paraphrase (a paraphrase drifts the intent
    it exists to preserve) and never the `<context>`-fenced composite an engine is
    briefed with: the memory holds what the PERSON said, so one calling agent's
    background for one call cannot become a standing requirement.
  - **`decisions`** — a short block the agent writes through `save_app`'s new
    optional `decisions` field: choices made, constraints found, things ruled out.
    REPLACED on every run that writes one, never appended, because a superseded
    decision presented as a current one is worse than no memory at all.

  Both are read back where the next editor actually reads: the edit brain's brief
  OPENS with the memory, ahead of the document, and the in-box builder's task
  context does the same. Without it an editor meets a deliberately filtered list
  and "fixes" it.

  Server-written throughout. `AppsRuntime.remember` is the one door that writes
  memory (`editor`-gated); a model-authored `memory` is stripped from a generated
  document, and an edit pins the stored one. Caps live at that write site rather
  than in the schema — the last 20 asks, 1KB of decisions — so a stored row
  survives a cap that changes. Reasoning traces, transcripts and tool outputs are
  deliberately not stored.

- f884bfe: Closes the two gaps behind #822's defect 1 (the canonical "compare weather in
  three cities" dashboard failing persistently on the BYO default model):

  - **The brain's direct-mode prompt now teaches the wire's real constraints.**
    `brainPrompt` had almost no dialect-syntax teaching for a direct (single-shot)
    answer — the fill-worker prompt had it, but a "tiny ask" never reaches a
    worker. The model reached for JS idioms the wire rejects: a method-call tool
    name (`cities.map`, `Math.round`), braces as text interpolation, and a loop
    variable with no declared query behind it. `brainPrompt`'s rules now say so
    explicitly, and that a fixed small set of named rows reads by array
    position off its query, never a loop.
  - **A direct answer that fails to compile now gets a retry.** `conductCreate`
    had a fix-it loop for every other outcome (`checkAndFix`, bounded at
    `FIX_ROUNDS`) except this one: a direct answer with ANY compile mistake
    (unknown tool, braces-in-text, an undeclared reference) returned
    `kind: "failure"` on the very first try, with no chance to self-heal from
    the compiler's own message. It now retries up to `FIX_ROUNDS` times, feeding
    the brain its own wire and exactly what was wrong with it — the same
    teaching-sentence discipline `fixInstruction` already uses.
  - **The wire's "unknown-reference" issue now names the declared queries**, the
    same way "unknown tool" already lists the real tools — a retry (from either
    fix above) gets something to pick from instead of guessing again.

- d6f5e28: Follow-up to #823: with the JS-idiom mistakes gone, "expected a single <App
  ...>...</App> element" became the dominant direct-mode failure — the model's
  answer wasn't wrapped in exactly one root `<App>` element. `brainPrompt` now
  states that rule explicitly, quoting the wire compiler's own error text, and
  the direct-mode retry loop's own instruction repeats it for the retry
  specifically. This failure was already reaching `conductCreate`'s #823 retry
  loop like any other compile issue (confirmed by test) — the gap was purely
  that nothing taught the model the rule in the first place.
- e6aaa7a: Two generation-hardening fixes, both aimed at a model correcting itself instead
  of an app failing outright:

  - **The `.data` envelope binding miss now names the fix.** When a binding reads
    a field that is actually one level down, under the tool's own `data` field
    (`sum(accounts, "balance")` where `accounts` is `{ data: [...] }`), the fact
    check's "the real fields are: data" message now also says which path to use
    instead (`accounts.data.balance`) — the fix-it retry gets the exact
    correction rather than just the shape.
  - **The plan's own vocabulary no longer leaks into a shipped app as an unknown
    component.** A worker filling a group, or the brain writing a whole app in
    one shot, occasionally copies the PLAN's own wrapper syntax
    (`<Leaf component="Stat" query="..." purpose="...">`, `<Group>`) verbatim
    into the markup it writes. `skeleton.ts`'s `withoutPlanVocabulary` already
    stripped `query`/`purpose` off a fill fragment's props; it now also resolves
    a stray `<Leaf component="X">` to the `X` it names and a stray `<Group>` to
    the `Stack` it always meant, and the same pass now also runs on the DIRECT
    create path (`validateCompiledCreate`), which has no fill fragment and
    previously had no defence against this at all.

- ab5d181: A READ through the app door takes the query arm, so an approved read's refetch
  lands.

  `apps.call` handed every call to `caller.call` — the arm with a random uuid per
  invocation. The guard's approved replay PINS the call id, so an ungraded read
  that parked on an approval could never be satisfied: approve, refetch, new id,
  park again, forever. It never surfaced because a `.vendo` screen's reads go
  through `createProgressiveQueryResolver`, which already calls `callQuery`;
  `apps.call` is the only door a code-land app (`@vendoai/kit`'s `useToolQuery`)
  has, so the wrong arm became reachable the moment code-land shipped.

  A call whose tool is graded `read` now takes `caller.callQuery`, whose id is
  derived from (app, tool, args) — exactly a query's identity. The discriminator is
  the tool's own authored risk grade, which is the server's existing classification
  of what a call does, so nothing new has to be declared and no second route
  appears. Every other grade (including `ungraded`) keeps the action arm: two
  identical mutations are two separate acts and each has to earn its own approval.

- d1ff923: The generation prompt's TOOL RESPONSE SHAPES section now teaches that a money
  field a host already signs (a credit or other liability account's balance
  arrives negative) sums AS-IS across every row a total is meant to cover —
  never filtered out by account kind, never wrapped in `Math.abs()`, and never
  manually subtracted via a second query. Follow-up to #818's root-cause
  investigation: the sign was always the data's own, never a hint any code
  change could touch, but the model had no explicit instruction ruling out
  filtering, `Math.abs()`, or a hand-rolled subtraction instead of trusting it.
- Updated dependencies [2e792a1]
- Updated dependencies [963d980]
- Updated dependencies [3f98372]
- Updated dependencies [21c8b10]
- Updated dependencies [1bb535b]
- Updated dependencies [8d623ec]
- Updated dependencies [a004031]
- Updated dependencies [2722d81]
- Updated dependencies [f884bfe]
- Updated dependencies [a5293af]
- Updated dependencies [b022eb3]
- Updated dependencies [c9df3f7]
- Updated dependencies [6eb8a04]
- Updated dependencies [fbf265b]
- Updated dependencies [2ed91b0]
- Updated dependencies [e6aaa7a]
- Updated dependencies [d0c3cc9]
- Updated dependencies [798b618]
- Updated dependencies [10a2b44]
- Updated dependencies [98eba22]
- Updated dependencies [f7c6da2]
- Updated dependencies [14e8246]
- Updated dependencies [fbf265b]
- Updated dependencies [38a840d]
  - @vendoai/core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [8f5a7c0]
  - @vendoai/core@0.7.0

## 0.6.1

### Patch Changes

- a2bd192: A Claude 5 model pinned through the model ladder can generate again (#692).

  `vendoModel()`'s lazy wrapper reports its family id (`"vendo-env"`) by design,
  so model-params' Claude 5 allowlist never saw the resolved rung's real id: the
  engine's `temperature: 0` rode through the ladder and a pinned Claude 5 model
  (`VENDO_MODEL=claude-sonnet-5` with `ANTHROPIC_API_KEY`) rejected every call
  with 400 "`temperature` is deprecated for this model". Sampling support is now
  re-decided at call time against the RESOLVED rung — the one moment the real id
  is known — dropping the sampling params such a rung rejects and setting the
  explicit output cap that guards against a sampling-era provider's silent 4096
  truncation. Sampling-era Claude and non-Claude rungs pass through untouched.
  `@vendoai/apps` exports the capability rule (`acceptsSamplingParams`,
  `UNKNOWN_MODEL_MAX_OUTPUT_TOKENS`) so the umbrella rides the engine's one
  allowlist instead of a copy.

  - @vendoai/core@0.6.1

## 0.6.0

### Minor Changes

- 3ae3d13: Delete template tool descriptions and the domains manifest.

  `vendo sync` no longer invents a description for a tool your API does not
  describe. The deterministic `"Use this to …"` generator is gone: an
  undescribed tool carries `""` in `.vendo/tools.json`, which is the honest
  keyless state. Sync's AI enrichment pass proposes real descriptions when a
  model credential is present, and `overrides.json → tools[name].description`
  still wins forever.

  The domains manifest is gone end to end. Generation already receives the full
  tool list, so a derived summary of tool nouns told the model nothing new — and
  a finite `hasNot` can never enumerate what a host lacks. Removed: the `domains`
  field from both `.vendo/tools.json` and `.vendo/overrides.json`, the
  `DATA DOMAINS` prompt section, and the `domains` provider slot on the apps
  runtime.

  Removed public API: `DomainManifest` and `domainManifestSchema` (from
  `@vendoai/core`); the `domains` field on `ToolsFile` / `OverridesFile`;
  `createApps({ domains })`. `mergedSemanticsAndDomains` is now
  `mergedHostSemantics` and returns the per-tool semantics record directly
  (the `MergedHostSemantics` wrapper type is gone).

  `.vendo/overrides.json` is strict, so a leftover `domains` key now fails
  loudly at parse — delete it and re-run `vendo sync`.

- a7199db: Chrome polish wave + the automation card's missing emitter.

  - **Status ribbon docks onto the composer** (Codex-style): narrower than the
    composer, top corners only, its bottom edge tucked behind the card — no more
    floating pill with a gap, on both the page surface and the overlay's
    dock-anchor DOM.
  - **Approval card de-escalated**: the ceremony card keeps the neutral surface
    with a single amber accent bar instead of the full yellow wash; the
    ALL-CAPS "CRITICAL" eyebrow is gone; risk slugs render in the user's
    language ("Irreversible", "Makes changes", "Read-only") with the raw slug
    intact on `data-risk` and the tooltip.
  - **App-card dot stands down when ready**: the pulsing build dot fades and
    collapses once the view is generated; the ready bar carries just the name.
  - **`.fl-btn` is a non-wrapping flex row**: icon + label ride one line (the
    connect card's "Connecting…" spinner no longer folds onto its own line).
  - **`VendoPage` accepts `thread`** (`suggestions` + `discoverability`
    passthrough to the chat tab), so hosts can move their curated landing onto
    the full workspace; Maple's Ask Maple page and Cadence's assistant now
    render the workspace console.
  - **The automation card now actually streams**: `vendo_apps_edit` ok-outputs
    that armed an automation emit `data-vendo-automation` from the agent tool
    bridge (name-scoped, 01 §16), and the apps runtime reports the armed
    trigger's true `enabled` state on `EditResult.automation`. The playground
    gallery gains an "Automation created" scenario.

### Patch Changes

- Updated dependencies [89153f8]
- Updated dependencies [3ae3d13]
  - @vendoai/core@0.6.0

## 0.5.0

### Minor Changes

- f95feb7: Runtime/generation wave: `apps.pipeline` threading through createVendo, `agent.instructions` host-voice seam, per-instance judge model binding (bindVendoModelSlots — the process-level slot registry is gone; `Judge.model` is now part of the guard's Judge contract), island-scoped repair + concurrent tier-0 paint lane with a monotonic partial gate, region-parallel assembly compiling the production inline-reference dialect, smoke-render environment failures skipping instead of failing apps, no-emoji contract rules, and per-lane generation logging (onTiming/onPipeline wired to the operator console).

### Patch Changes

- 0b58e3e: Generation now rejects capability substitution: a mutating host tool invoked with a hand-typed target or amount is sent back to repair instead of shipped. The live defect this closes had a generated island calling `host_transferMoney({ amount: 1, recipient_name: 'Slack Forwarding Bot', memo: 'APPROVED TRANSACTIONS: …' })` on a host with no messaging tool — a payments API used as a message channel, with a real side effect. The rule is mechanical (argument provenance, not intent matching): operands that arrive through tool data, user input, form state, or a row the user acted on always pass; the values the user themselves named in their request always pass; enums, flags and consts a tool declares never trip it. Both surfaces are covered — declarative action payloads and `tools.*` calls in island source. When the host lacks the capability, the honest disclaimer path is the only valid answer.
- 0e3bc0a: Generation works on the Claude 5 model line. The engine hardcoded `temperature: 0` at every model call, but Claude Opus 5 / Sonnet 5 / Fable 5 (and Opus 4.7/4.8) removed the sampling parameters and reject the request outright with `400 — "\`temperature\` is deprecated for this model."`, so a host configuring any of those models could not generate at all. Sampling is now capability-gated on the model id: temperature is dropped only where the model rejects it and `temperature: 0`is preserved everywhere else. The same gate sets an explicit output cap on those ids, so a host whose`@ai-sdk/anthropic`predates the 5 line can no longer silently fall back to`max_tokens: 4096` and truncate a generated app mid-wire.
- f965d77: A create whose document generated cleanly no longer loses the whole turn when the store refuses to persist it. The final view part was emitted _after_ `apps.put`, so a rejected write took the settling emit with it: every streamed card froze on whatever mid-stream payload it last held (a half-painted chart, an empty-state table) with no way to tell a frozen card from a genuinely empty one, the create tool answered the agent with a bare error, and the agent apologized and rebuilt the same app twice more — three cards for one prompt, none of them saved, nothing logged on the user path. Live on the deployed Maple demo, whose Cloud store was rejecting every `vendo_apps` write.

  Now the finished view is emitted before anything that can fail, a failed persist degrades the app to view-only instead of discarding it, and the failure is named in the operator log (`app not saved (<id>): the view rendered but the store rejected it`, plus `(NOT SAVED)` on the completion line) and handed to the agent as an `unsaved` note on an `ok` result — so it states the one true thing and stops, instead of apologizing for a view the user can see. Escalation is skipped for an unsaved app, since every rung writes through the same store. Separately, a query that resolves non-ok now warns once instead of silently rendering an empty card.

- 280a142: Generation repair now repoints an array-expecting prop that landed on a `{ data: [...] }` wrapper object, instead of regenerating the whole app. Live on the Maple demo, the most obvious prompt ("Show my spending by category") never rendered: the model bound the donut's `slices` array prop to the spending tool's ROOT object, validation correctly rejected it (`expected an array, the bound field is object`), and — because a kind mismatch is not a compile _binding_ error — structured repair's closed fix space was empty, so every attempt paid a full-lane regeneration. When the bound object holds exactly ONE top-level array, repair now derives the nested path and splices it with no model call; ambiguous shapes (zero or 2+ arrays) keep today's behavior. Any host returning an envelope instead of a bare array hit this.

  `vendo sync` also records a host's DECLARED response body: an OpenAPI 2xx `application/json` schema becomes `outputSchema` on the `.vendo/tools.json` entry (refs resolved), so the envelope a host returns is part of the committed contract rather than something the model infers. Nothing is invented when the spec is silent.

- Updated dependencies [0b58e3e]
- Updated dependencies [cbffc9e]
- Updated dependencies [c7277f6]
- Updated dependencies [da9d4a9]
- Updated dependencies [f5fbb4b]
- Updated dependencies [221b851]
- Updated dependencies [d1364b6]
  - @vendoai/core@0.5.0

## 0.4.8

### Patch Changes

- 9f01a92: Two fixes from the first full init→app-generated e2e on real workerd:
  the island TSX validator's esbuild import is now bundler-blind (Wrangler
  inlined the Node-only package into Worker bundles, where its \_\_filename
  crash was misread as "invalid TSX" and failed EVERY app build — the field
  report's apps-create death), and a validator that crashes at runtime now
  degrades to no validation instead of failing every island. The CLI also
  accepts `--framework custom` (the flag whitelist had missed it; only the
  programmatic path worked).
  - @vendoai/core@0.4.8

## 0.4.7

### Patch Changes

- fd9260d: Empty-states batch — a fresh install's FIRST generated app now renders well
  with no bindable host data. Generation always emits the requested component
  bound to its tool (the Kit renders the designed empty state) instead of
  omitting it or writing prose into a tile; the no-data explanation is one
  consolidated "About this view" note, charts route to the Kit, and the app
  name is a <=40-char display title (validated on create) instead of the
  request echoed back. The Kit stat tile shows a compact em dash for empty
  values and truncates prose-length text into a tooltip, empty label/value
  pairs render an em dash, and the in-thread app panel scrolls its top into
  view when a live build settles. The create-app tool description also stops
  callers baking pre-computed figures or branding into the prompt.
  - @vendoai/core@0.4.7

## 0.4.6

### Patch Changes

- 60c5e39: A create_app build can no longer die silently (0.4.5 E2E cert defect D, byo-ai-sdk host). Three layers: a build whose every region was disclaimed away ("This part of the request isn't available on this host.") now fails terminally with an honest host-capability reason instead of persisting as a "successful" app that reads as a build hanging forever; a server-side build watchdog persists a terminal failed record when a build task neither completes nor throws inside its window (VENDO_APP_BUILD_WATCHDOG_MS, default 4 min), so the embed always resolves even if the build promise hangs or is severed by the host runtime; and the embed's build deadline is now an absolute client-side timer with a per-poll timeout, so a hung open() poll can no longer freeze the building beat past the deadline.
  - @vendoai/core@0.4.6

## 0.4.5

### Patch Changes

- 31f899e: A chat turn whose app build terminally fails now ENDS, with the classified
  failure reason visible in the thread. Before, the failed build came back as a
  plain error outcome only the model could see: the tray rendered nothing, and
  the model re-ran the minutes-long doomed build inside the same turn until the
  step cap — a thread stuck "streaming" for 10+ minutes with no banner and no
  reason (0.4.4 E2E cert). The agent's tool bridge now streams an additive
  `data-vendo-build-failed` part (toolCallId + the runtime's canned, non-leaky
  reason) beside the failed `vendo_apps_create` result, the agent loop stops the
  turn after the failed build (re-asking is the user's call, matching the BYO
  embed's failed vocabulary), and the thread renders the part as an error beat
  with the reason.

  The generation engine also names an empty model stream as its own failure
  class ("completed without any text output") instead of reporting the empty
  string's wire-parse issues — the 0.4.4 cert's "wire missing-app / empty
  layout" failures were a gateway alias ending turns reasoning-only, not a
  model-format defect, and the old issue list mis-routed that triage.

- 87eadba: fix(venue): e2b is only selectable when actually usable — 0.4.4 regression

  `e2bInstalled()` treated a runtime without `import.meta.resolve` as "the
  bundler inlined the SDK, so it must be available". Inside Turbopack/webpack
  server bundles that fallback always fired, so a stray `E2B_API_KEY` (for
  example inherited from the shell) flipped the venue ladder to an e2b the
  runtime could never load, outranking the Vendo Cloud sandbox and killing
  every server-app build — 0.4.3 printed `execution venue: cloud`, 0.4.4
  printed `e2b` on the same host. The probe now tests usability instead of
  importability: it asks Node's own resolver (`require.resolve` via
  `process.getBuiltinModule`, which works inside server bundles), falls back to
  a real `import.meta.resolve`, and reads an unverifiable runtime as NOT
  installed — the SDK is never bundler-inlined (the mutable-specifier import
  from the edge-portability work guarantees it), so the runtime resolver is the
  only truth. With `VENDO_API_KEY` set and no usable e2b, the venue is the
  Cloud sandbox again.

  `vendo doctor` also stops false-blessing the venue: `execution venue: e2b`
  now passes only when `E2B_API_KEY` is set and the `e2b` package resolves from
  the project; otherwise it fails with E-LIVE-007 and a concrete fix line.

- Updated dependencies [31f899e]
  - @vendoai/core@0.4.5

## 0.4.4

### Patch Changes

- 835d17a: Edge-runtime portability: the server entry now bundles and boots on
  Web-standard runtimes (Cloudflare Workers first). Fetch defaults are
  invocation-safe, the optional e2b SDK no longer breaks esbuild/Wrangler
  builds, Node-only legs (local store engines, dev model ladder, telemetry
  disk config, actions sync tooling) sit behind worker/edge export
  conditions with honest guidance, and createVendo performs no I/O, timers,
  or random generation at construction — module-scope wiring works. A CI
  portability gate (bundle + real workerd boot) keeps it that way.

  Note for hosts that reach into composed blocks directly: the BYO tool seam
  (`vendo.guardedTools`, and the ai-sdk/mastra packs built on it) arms schema
  readiness on first execute. Raw `vendo.store`/`vendo.automations` reach-ins
  should `await vendo.store.ensureSchema()` first — the previous eager kick
  only ever gave that pattern a racy head start.

- Updated dependencies [835d17a]
  - @vendoai/core@0.4.4

## 0.4.3

### Patch Changes

- a48b1b7: Wave 2 runtime fixes from the 0.4.x E2E certification campaign:

  - Mastra shim: open-schema guarded tools (extracted routes whose body shape
    is untyped) no longer execute with `{}` when the user dictated args.
    Mastra's provider schema-compat layers hard-close every object schema for
    strict-mode providers, so an open input reached the model as "takes no
    arguments"; the shim now bridges open inputs through one declared `args`
    property (JSON object or JSON-encoded string) and unwraps it before the
    guard, so approvals park — and replay — with the real arguments.
  - Failed app builds now carry their reason everywhere: `create()` re-throws
    with the classified reason in the message (the tool outcome the calling
    agent reads), logs the un-canned issue list to the operator terminal
    (previously a silent failure), and the app embed shows a retry hint for
    retryable failures. The generation engine now captures streamText's
    swallowed provider errors, so quota/timeout/no-key failures classify
    correctly instead of collapsing to "generation failed".
  - The dev model's no-usable-credential lines (missing provider package, no
    key at all) surface verbatim in the failed-build reason — the in-surface
    error now carries the actionable `npm install @ai-sdk/...` / `vendo login`
    instruction instead of `model could not produce a valid app`.
  - `@vendoai/ui` DonutChart no longer crashes on `undefined`/non-array data
    inside generated apps; it renders the designed empty state like the other
    Kit charts.
  - @vendoai/core@0.4.3

## 0.4.2

### Patch Changes

- @vendoai/core@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [b7a860f]
  - @vendoai/core@0.4.1

## 0.4.0

### Minor Changes

- 0e94fa6: Secrets egress fetch shim (ENG-290 M4, 06-apps §4.3/§4.5 option B).

  - **In-sandbox fetch shim**: every machine now carries a runtime-owned
    `/app/.vendo/fetch-shim.cjs`, loaded at boot via `NODE_OPTIONS --require` by
    the rung-2/3 boot convention, the rung-4 served-app scaffold's `start.sh`,
    and Modal's create command. Outbound `fetch(externalUrl)` from app code is
    rewritten into `POST {VENDO_PROXY_URL}/egress` authenticated by the run
    token, so plain `fetch` with a declared secret handle in a header or body
    authenticates to allowlisted hosts — substitution stays exclusively at the
    proxy, outside the sandbox. Internal requests (relative URLs, the proxy
    itself, loopback) are never rewritten; a refused egress surfaces as an
    ordinary fetch `TypeError`, never a leak.
  - **Interchange**: `.vendoapp` exports exclude the runtime-owned shim, and
    imports rebuild machines with the current shim (an archive can never smuggle
    a modified one in).
  - Env-gated live lanes prove the shim on real E2B (Modal lane parked on
    missing `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`, exactly like the ladder
    lanes).

- 7826a6e: feat(apps): guarded per-secret in-sandbox exposure toggle (ENG-345)

  Adds the off-by-default exception path to the Option B secrets gateway: an
  owner-only, per-secret × per-app toggle that injects a secret's real value into
  the sandbox env instead of a handle. Flipping it on is a high-risk action gated
  by the guard's existing approval flow; every run with an exposed secret emits an
  audit event; and the grant lives outside the app document so it never travels
  with a share, remix, fork, export, or import (copies always revert to handles).

- 8d5423d: Generation speed: add an opt-in `onTiming` seam around `modelEngine.create` (per-lane first-paint / complete timing + token usage) and a best-effort `runtime.prewarm()` page-open model warm-up. Additive — no change to create/paint/render behavior.

### Patch Changes

- 023b3c0: Security hardening (ENG-251).

  - **Run-token anti-replay** (`@vendoai/apps`): run tokens now carry a random `jti`
    nonce. A run's jti is burned when its machine is torn down, so a captured token
    replayed afterwards is rejected at the proxy even though its HMAC and TTL still
    verify — shrinking the replay window from the full 15-minute TTL to the live run.
    A token remains valid for every callback of its own live run (tools, state,
    egress), so legitimate repeated proxy calls are unaffected. A token minted with
    no `jti` fails closed.
  - **Timing-safe `/tick` compare** (`@vendoai/vendo`): the `VENDO_TICK_SECRET`
    bearer check used plain string equality (a timing oracle). It now uses a
    WebCrypto HMAC-digest constant-time compare — edge-safe, no `node:crypto`.
  - **Bounded ephemeral-subject set** (`@vendoai/store`): the anonymous-visitor
    ephemeral-subject set is now a bounded LRU (10k) instead of growing until
    process restart. The subject registered for the current request is never the
    one evicted.

- 7546de1: Inject the standard run environment when `importApp` provisions a machine (ENG-347, 06-apps §4.2).

  Import rebuilt an app-directory machine with `env: { PORT }` only, bypassing the
  shared env helper the create/edit path uses. The secrets egress fetch shim then
  declined to install (it requires `VENDO_PROXY_URL` + `VENDO_RUN_TOKEN`), so an
  imported rung-2/3 app could not reach host tools or the egress endpoint until it
  was re-edited. Provisioning now routes through the machine cache, baking the same
  §4.2 run environment (`PORT`, `VENDO_PROXY_URL`, a freshly minted `VENDO_RUN_TOKEN`,
  and declared secret handles) into the rebuilt snapshot, so an imported app reaches
  tools/egress with no subsequent edit.

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

- Updated dependencies [49e9ccc]
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [fa0ad98]
- Updated dependencies [51f3fc9]
- Updated dependencies [ff6b5d5]
  - @vendoai/core@0.4.0
