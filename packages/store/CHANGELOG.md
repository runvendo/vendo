# @vendoai/store

## 0.10.0

### Minor Changes

- e2128aa: App generation moves into one package, behind two doors

  `@vendoai/apps` now has a browser-safe **contract door** and a node-only
  **engine root**. The app format — the document, the two genui dialects and their
  compilers, the Kit, the island/jail rules, catalog + theme, the checking
  contract, remix provenance, and the wire shapes `/apps/*` returns — lives on
  `@vendoai/apps/contract`, which imports no node built-ins. The behavior that
  produces those shapes stays behind `@vendoai/apps`.

  **Migration:**

  1. **Moved `@vendoai/core` names are a hard rename** — import them from
     **`@vendoai/apps/contract`**: the genui dialect (`validateTree`, `compileWire`,
     `compilePlan`, `printWire`, the expression grammar), the Kit, the
     island/jail rules, catalog + theme, `AppFloor`/`Check`/`CheckInput`,
     `ScreenAssembler`, `MakeReceipt`, host components, and build deadlines.
     Types reaching you through `@vendoai/vendo` or the `vendoai` alias are
     **unchanged** — the umbrella re-exports the contract beside core.
     `@vendoai/apps` is ESM-only, so `require()` of these _values_ needs ESM or
     the umbrella.
     `AppDocument` and its schemas, and `Finding`, deliberately **stay in
     `@vendoai/core`** (the store contract and the harness runtime speak them);
     the contract door re-exports them, so one door serves every consumer.

  2. **Subpaths — what moved and what did not.** Entry points go 8 → 4:

     - **`@vendoai/apps`, `@vendoai/apps/e2b` and `@vendoai/apps/testing` all
       survive with their specifiers unchanged.** `./e2b` stays because the venue
       ladder reaches it as a real module seam, not merely a convenience re-export.
     - `@vendoai/apps/{sandbox-ladder,internal}` **fold into `@vendoai/apps`** —
       import those names from the root.
     - `@vendoai/apps/adapter-conformance` → **`@vendoai/apps/testing`**, not the
       root: it imports `vitest`, and the root rides every composed host's server
       path.
     - `@vendoai/apps/claude-turn` → **`@vendoai/harnesses/claude-turn`** and
       `@vendoai/apps/box-door` → **`@vendoai/harnesses/box-door`** (both moved with
       `claudeCode()`).
     - **NEW:** `@vendoai/apps/contract`.

  3. **`@vendoai/ui`, `@vendoai/store`, `@vendoai/actions` and `@vendoai/mcp` now
     depend on `@vendoai/apps`** and read the app format from
     `@vendoai/apps/contract`. Their own public surfaces are unchanged.

  **Known tradeoffs, stated plainly:**

  - **One name, still two declarations.** `@vendoai/ui` no longer keeps its own
    copy of the `/apps/*` wire shapes — it re-exports them from the contract
    door. That removes a copy; it does not yet make one definition. The engine's
    server door declares its own richer `EditResult` (with `failure`,
    `graduated`, `box`, `pendingEgress`, `automation`) beside the contract's
    four-field wire shape, so the name has two declarations inside
    `@vendoai/apps`, one per door. Unifying them decides which fields the wire
    may expose, which is a behavior change and not part of this move.
  - **Install weight.** `@vendoai/apps` declares `esbuild`, `jsdom`, `fflate` and
    `react-dom` as hard dependencies, so a browser-only consumer of
    `@vendoai/apps/contract` still installs the engine's dependency set. The
    contract door itself bundles clean for a browser target (enforced by a new
    leg in `scripts/portability-gate.mjs`); it is the install graph, not the
    bundle, that carries the weight. Pre-existing, amplified by this split.

- 0f46e44: Dead features and their public surface are gone. Every removal below had zero
  callers in this repo, the console, or the examples; nothing changed behavior for
  a caller that was using a live path.

  **`@vendoai/core` (breaking).** `AppDocument.placements` is gone from the
  interface and the schema, and the validator no longer checks it. There has been
  no writer since the placements-as-rows split; "show this app in that slot" is a
  placement ROW (`@vendoai/apps` `placements.ts`, `GET /apps/placements`), which
  is unchanged and is the live feature. Also removed: `PlanIsland` and the
  `AppPlan.island` field, because the plan-level `<Island name purpose/>`
  declaration no longer parses; and `PackSkill`, the deprecated alias for `Skill`.
  `Pin`, `pinSchema` and `AppDocument.pins` are untouched — fork provenance is
  still live.

  **`@vendoai/apps` (breaking).** `PinShipRequest`, `PinApproval`,
  `pinShipRequestSchema` and `pinApprovalSchema` never ran; `ShipDiffPin` and
  `inClientApprovalSchema` are the live path and stay. `bindingKindCheck` is gone
  — it had no callers; the `bindingKindIssues` walker it wrapped is still used by
  the validate path. The plan compiler no longer accepts a plan-level
  `<Island name purpose/>` element (an inline `<Island>` inside an app file is a
  different, live feature and is unchanged). `GenerationPromptSection["id"]`
  narrows to `"theme" | "design-rules"`; the other five ids had no producer.

  **`@vendoai/store` (breaking).** The `stateStore` and `approvalStore` helpers
  are gone. Both were test-only wrappers over the routed `records("vendo_state")`
  and approval write paths, which are unchanged and are what production uses.
  `ApprovalRow` is unaffected — it is exported from `helpers/types.ts` as before.

  **`@vendoai/agents` (breaking).** The `./harnesses` subpath export is gone.
  Import the harness factories from their own package instead:
  `import { claudeCode } from "@vendoai/harnesses/claude-code"` and
  `import { vendo } from "@vendoai/harnesses"`.

  **`@vendoai/knowledge`.** `knowledgeIndexSummary` and `parseKnowledgeConfig` are
  no longer exported from the package root. Both functions stay and are still used
  internally by `knowledgeIndexResolver`, which remains exported.

  **`@vendoai/actions`.** `DEFAULT_CAPTURE_BUDGET_BYTES` is no longer exported.
  The constant and the 256 KB default it sets are unchanged.

  **`@vendoai/ui`.** The unexported, unreferenced `TakeoverPortal` component is
  deleted.

- 61b75bd: One definition per concept, and one door in

  Every app write that mints or changes a document now passes the same admission
  gate, and the concepts that were declared in five places are declared once.

  **The one door.** `admitAppDocument({document, origin})` ships from
  `@vendoai/apps/contract` — pure, browser-safe, structural schema plus the
  cross-field rules, with `validateAppDocument` still exported as its inner half.
  `origin` is recorded on the refusal and never changes what is checked. It is
  called from exactly one place: the row writer in `server/persistence`.

  **The door sanitises as well as validates.** The venue verdict (`inClient`),
  the drift report (`pinDrift`), the `dataUnavailable` claim and CDN furnishing
  packages are server-authoritative: only code that verified the hash, compared
  the baseline or ran the queries may assert them. They were stripped on the way
  OUT, which kept a forged claim off the wire but left it in the row — three
  write paths each remembered to strip first and `importApp` did not. The row
  writer strips them now, so a reader that forgets can no longer be wrong.
  **Pre-existing, fixed here rather than introduced here.**

  **One named exception, stated out loud:** `@vendoai/automations`' `writeApp`
  puts the row directly. Its two callers flip `enabled` on a document they
  round-tripped unchanged out of the store, and forcing them through admission
  would let a document stored before this door existed refuse a _disarm_ — a
  safety control must not fail by refusing to turn something off.

  **Breaking**

  - `@vendoai/mcp` no longer exports `AppsPort`. It was a structural mirror of
    `AppsRuntime`; the door types its apps ride-along off the real runtime, so
    the two can no longer disagree. Hosts that named the type should use
    `NonNullable<McpDoorConfig["apps"]>`. Note that the mirror typed `call` as
    `Promise<unknown>` while the umbrella has always wired `AppsRuntime.call`,
    which returns a `ToolOutcome` — the real shape is now visible in the types.
  - `appRecordInput`, `updateAppRow` and `persistEdit` (all internal to
    `@vendoai/apps`) take a required `AdmissionOrigin`. Required, not defaulted:
    a default would let a write path record itself anonymously.
  - `@vendoai/automations` renames its row type `AppRow` → `AppData` and drops its
    local `appRowSchema`, both of which now come from `@vendoai/apps/contract`.

  **Retired from the plan: the `vendo_make` envelope unification.**

  The MCP door was to answer `vendo_make` with the same `vendo/app-ref@1`
  envelope the in-process tool pack returns. It is not shipped, for two reasons:

  1. It breaks a tested door-parity law — the in-process leg and the door leg
     must return the same output, and the envelope made them disagree.
  2. It would make the door state something false. The envelope's `status` is
     pinned to the literal `"building"` and documented as _"never means done,
     win or lose"_, because it exists for the fast-return path where the build
     is still streaming. The MCP door does not stream; it runs `vendo_make` to
     completion. Wrapping a finished build in it tells an agent the app is not
     built when it is.

  The receipt is the honest answer on a door that runs to completion. Reviving
  this needs a non-`"building"` status and a deliberately rewritten parity law,
  as its own change.

  **Unifications**

  - `AppRow` / `AppData` / `appRowSchema` — the stored row, declared once in
    `@vendoai/apps/contract`. It was five: the store's projection, the automations
    engine's read shape, the persistence layer's `AppRowData`, a structural alias
    in `write-surface.ts`, and a narrower mirror in the umbrella's sync reader.
  - `data-vendo-view` — one producer, `vendoViewPart` in `@vendoai/core`. Four
    writers hand-built the part and only two validated it.
  - `WIRE_RESHAPE_OPS` is now derived from `RESHAPE_OPS` minus the aggregates
    rather than listed a second time, so the two cannot drift.
  - `stripServerAuthoritativeFields` moves to `@vendoai/apps/contract` (it is pure
    and browser-safe) and is re-exported from the package root, so the console can
    stop hand-copying it.
  - `AppData` is declared beside `AppRow` in the contract, replacing the console's
    mirror of a type `@vendoai/store` never exported.
  - The corpus structural layer's expected-files list gains `.vendo/catalog.json`
    and `.vendo/theme.extracted.json`, both of which every real `vendo init`
    writes; its duplicated tool-identity join collapses to one copy.

### Patch Changes

- Updated dependencies [e2128aa]
- Updated dependencies [e1032f9]
- Updated dependencies [079d7d8]
- Updated dependencies [0e51585]
- Updated dependencies [e87a765]
- Updated dependencies [8105ade]
- Updated dependencies [361f9b9]
- Updated dependencies [b0a165c]
- Updated dependencies [1549f90]
- Updated dependencies [591ea46]
- Updated dependencies [e87a765]
- Updated dependencies [79d7088]
- Updated dependencies [79d7088]
- Updated dependencies [89b4444]
- Updated dependencies [0f46e44]
- Updated dependencies [70644e3]
- Updated dependencies [d9ae728]
- Updated dependencies [61b75bd]
- Updated dependencies [384eb09]
  - @vendoai/core@0.10.0
  - @vendoai/apps@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [18c77cd]
  - @vendoai/core@0.9.0

## 0.8.1

### Patch Changes

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

- f1b30a1: `s3()` is gone from `@vendoai/store` and from the `@vendoai/agents` root, along
  with the `S3FilesOptions` type. The `files:` seam is unchanged: it takes a
  `FilesAdapter` — three methods, `{ put, get, delete }` — exported from
  `@vendoai/core` and the umbrella, and a host object in that slot has always won
  over anything shipped.

  Pre-1.0 hard cut, no shim. If you wired `files: s3({ … })` (or
  `postgres(url, { blobs: s3({ … }) })`), pass your own `FilesAdapter` pointed at
  the same bucket and prefix. Blobs already written are untouched: the keys are
  minted by the store, never by the adapter, so the same objects read back with no
  migration. The `aws4fetch` dependency drops with it, and the over-cap
  store-backed file error now names `files:` and `FilesAdapter` instead of `s3()`.

- dd441cb: Five correctness fixes. No public surface changes, no stored shape changes, no migration.

  **One rule for a transcript row's id.** `threadMessageRowIds` (TypeScript) and
  `replaceThreadMessages`'s `COALESCE(elem->>'id', …)` (SQL, twice) expressed the
  same rule in two dialects that disagree: `elem->>'id'` yields `''` for
  `{"id":""}` rather than NULL, and `'5'` for `{"id":5}`. The duplicate-id guard
  runs on the TypeScript rule, so those inputs cleared it and then collided inside
  the INSERT, failing with the bare Postgres 21000 the guard exists to prevent and
  losing the whole write. The ids are now derived once and passed in as a
  `text[]`; both `COALESCE` expressions are gone.

  **`threadStore.delete` takes the transcript with it.** It dropped the thread row
  and the harness-state row but never `vendo_thread_messages`, which has no
  foreign key. A message row carries no subject of its own, so those rows became
  permanently unreachable — `erase.bySubject` reaches them only through
  `thread_id IN (SELECT id FROM vendo_threads WHERE subject = $1)`, which is empty
  once the thread is gone. It is now the same cascade
  `ops.transcripts.deleteThread` already ran, in one transaction, still guarded on
  the RETURNING row so a foreign principal's delete sweeps nothing.

  **One grant row per (app, principal), on every records adapter.** `appAccess`
  minted a fresh `ag_<uuid>` per `grant`; uniqueness came only from
  `ON CONFLICT (app_id, principal)` in the local Postgres routing door, which no
  hosted or BYO adapter has. A second row made downgrades silently fold back to
  the stronger level and left `revoke` deleting only the first match. `grant` now
  reuses the existing row's id, and `revoke` deletes every matching row.

  **A grant no longer races itself.** Reading the grants and only then minting an
  id is a read-then-write window: two overlapping grants both read "no row for
  this principal", both mint a different random id, and the duplicate pair — with
  its dead downgrade — is back. A principal with no row yet now gets a DERIVED id,
  `ag_<appId>_<principal>`, the same id core's reference adapter derives, so the
  write is one put on one key and the overlap collapses to last-write-wins on a
  single row. An id already on disk still wins, so nothing stored is re-keyed.

  **A concurrent transcript write can no longer escape the delete cascade.** The
  cascade is one transaction, but a writer that only READS the thread row takes no
  lock on it, so under READ COMMITTED its snapshot still shows a row the cascade
  has removed and not yet committed — the message lands after the sweep and
  outlives its own thread, unreachable for the same reason the cascade exists.
  `recordAnswer` and `threadMessageStore.upsert` both did this while reporting
  success; their ownership reads now end in `FOR KEY SHARE OF t`, the same lock a
  foreign key takes. `putThreadRow` and `ops.transcripts.putMessage` were already
  safe and are unchanged.

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

- 21c8b10: One brain, one scheduler, and consent that is per trigger — everywhere outside
  `@vendoai/automations` that has to agree with it.

  A fire-time call now carries WHICH trigger fired (`TriggerRef.id`) and WHICH
  firing it belongs to (`TriggerRef.lineageId`), so the guard matches an away grant
  on (app, trigger) instead of app-wide — arming one trigger no longer authorizes
  its siblings — and keys effect receipts on the firing, so re-running a run that
  failed loudly cannot repeat the work the first attempt already completed. The
  store carries that dimension too: grant and run rows index the trigger, so an
  adapter that trusts its own refs narrows exactly as far as the engine does
  instead of handing back a sibling trigger's grant. An agentic firing runs through
  the same away runner the rest of Vendo uses, seeing only the connector dispatcher
  it was actually granted. A machine app's `vendo.json` schedules are folded into
  its document triggers when the manifest syncs, so there is exactly one scheduler
  in the deployment (the automations engine) and one tick that drives it. The panel
  and the wire follow: per-trigger enable, disable, dry-run and adopt doors, a
  `POST /runs/:runId/rerun` door, and a run that stopped for a missing permission
  showing "Failed" with the consent card and Grant & re-run right on the row.

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

- 10a2b44: **BREAKING:** `workspaceBash()` is removed from `@vendoai/store`, with its
  `BashRun` and `WorkspaceBashSetup` types.

  It was written as "the canonical in-process bash setup over a workspace" and
  then never wired to anything. The only harness that runs real bash runs it
  INSIDE a box (`claudeCode()`, where the box's own shell and its own `/tmp` are
  real), and the machine-less harness (`vendo()`) hands the model AI-SDK tools,
  not a shell — so the `/tmp` alias and the refusal-to-exit-code translation
  existed for zero callers, in this repo and in the console.

  Nothing in Vendo imported it and it was never documented as public API (absent
  from the store README, from `docs/`, and from the archived store contract), so
  the realistic blast radius is nil — but it was an exported symbol, and removing
  one is a breaking change whether or not anybody held it.

- f7c6da2: A strict mount guards its creates, a refused turn writes nothing, and eleven
  exports nobody imported are gone.

  `expectedRevision` on a workspace commit entry gains its third state: a number
  compares, `null` means "this path must not exist yet", and the absent field
  stays unguarded. The SQL backend already refused a create built on a base that
  had moved; the hosted backend required a number and so degraded exactly that
  case into an unguarded write, silently overwriting the colleague who created
  the shared `/orgs` file first. Both backends and the memory reference are now
  held to the same conformance case.

  The per-turn refusal on a store that can serve neither the transcript nor the
  workspace is atomic: the doors are resolved before the first write, so a
  refused turn no longer leaves a `vendo_threads` row carrying the user's message
  on a deployment that can never answer it.

  `@vendoai/harnesses` drops eleven exports with no importer anywhere
  (`abandonPendingApprovals`, `guardApprovalIds`, `addAgentTool`,
  `buildAgentTools`, `guardedCall`, `previewApproval`, `computeInitialLoadout`,
  `createToolSearchSession`, `CAPABILITY_MISS_TOOL_NAME`,
  `createCapabilityMissDetector`, `scrubCapabilityMissText`). The `./vendo`
  subpath is untouched.

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

- b576ab9: Transcripts and harness state ride StoreOps, so a hosted store can serve a
  harness turn.

  `threadMessageStore` and `harnessStateStore` opened with `dbFor(store)` and threw
  "Unknown VendoStore handle" for anything `@vendoai/store` did not mint — which is
  every key-only deployment. So `storeServesHarnessTurns` answered false for them
  and the host silently fell back to the legacy chat path: hosted deployments could
  not use `harness:` at all.

  - `VendoStore` gains an optional `ops?: StoreOps`. The Cloud `hostedStore` already
    exposed one, so it satisfies the member with no change.
  - One internal selector, `backendOf`, decides for every store-shaped helper: the
    SQL handle when there is one (same database, one hop shorter), the store's own
    32-op surface when there is not, and a named `not-implemented` refusal only when
    the store offers neither. Nothing above the store package can tell the two
    apart — no caller changed.
  - Transcripts ride the wire as-is: `transcripts.putMessage` for the write,
    `transcripts.getThread` for the read, ownership enforced against the thread
    record's subject exactly as the SQL join enforces it against `vendo_threads`.
    A foreign or absent thread reads as empty and refuses writes, as it does
    locally. A guarded (`expectedRevision`) edit has no wire expression and is
    refused loudly rather than downgraded to last-write-wins; no runtime caller
    asks for one.
  - Harness state rides the wire's `harness` family under the SAME slot the SQL
    half uses (`harness_state:<threadId>`, keyed by the thread's owner), so §1.3's
    rules — one slot per thread, a foreign harness destroying rather than shadowing
    it, the slot dying with its thread — hold on both backends.

  The harness-turn refusal now names both options instead of only SQL, and the
  route probe accepts an ops-capable store.

  Proven where it counts: one behavioral suite for each helper runs against three
  backends (real Postgres/PGlite, core's `memoryStoreOps`, and the local 32-op
  backend), and a live seam test writes through the real helper over a real
  `hostedStore` against the real console and reads it back on a second,
  freshly-constructed client — no stub on either side.

  Known gap, recorded as a live `it.fails` rather than a comment: the console's
  `transcripts.putMessage` appends instead of editing by id, so re-writing an
  already persisted message (the approval flip) is refused there. The fix is
  console-side; the local backends already do the right thing.

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

### Patch Changes

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

- @vendoai/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [89153f8]
- Updated dependencies [3ae3d13]
  - @vendoai/core@0.6.0

## 0.5.0

### Minor Changes

- 22601e3: Add the dedicated knowledge record collections `vendo_knowledge_docs` / `vendo_knowledge_chunks` (MCP-door table layout: id/data/refs/created_at/updated_at, GIN index on refs, newest-first keyset index) and bump `SCHEMA_VERSION` 4→5 so existing databases actually create them (the DDL loop only runs while `version < SCHEMA_VERSION` — review fix F1). Both tables join the erase-by-subject/app cascade.
- f49b1de: New `@vendoai/store/postgres` entry point: the same store (schema, records, blobs, secrets, helpers) with a `createStore` that requires a Postgres `url` and keeps `@electric-sql/pglite` out of the module graph entirely. The main entry is unchanged — PGlite stays the zero-config dev default — but serverless consumers on a real Postgres (Cloudflare Workers, Lambda, Vercel) should import from `@vendoai/store/postgres` so their bundles stop carrying megabytes of wasm Postgres they can never execute (a console Worker in the field silently crossed Cloudflare's bundle size ceiling this way). Purity is enforced by a new portability-gate leg (node-resolution esbuild metafile over `dist/postgres.js`) and a PGlite import tripwire test.

### Patch Changes

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

- @vendoai/core@0.4.8

## 0.4.7

### Patch Changes

- @vendoai/core@0.4.7

## 0.4.6

### Patch Changes

- @vendoai/core@0.4.6

## 0.4.5

### Patch Changes

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

- 49e9ccc: Add database-level atomic claims for multi-instance OAuth code redemption and refresh-token rotation.
- 0032a67: Add optional atomic record claims and revision CAS, use them to deduplicate multi-instance automation firing, and abort in-process agentic runs when stopped.
- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.

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
