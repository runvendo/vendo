# @vendoai/guard

## 0.21.0

### Patch Changes

- Updated dependencies [6856b4f]
- Updated dependencies [491a2fa]
- Updated dependencies [37ed821]
- Updated dependencies [6856b4f]
  - @vendoai/core@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [095f143]
- Updated dependencies [7fcf60b]
- Updated dependencies [cfd4f48]
  - @vendoai/core@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [2879e46]
- Updated dependencies [39a1c78]
- Updated dependencies [5f4d694]
  - @vendoai/core@0.19.0

## 0.18.0

### Minor Changes

- 88ec7e6: The client stops re-reading, per tool call, what it already knows. `frozen({ cached: true })` serves the CHECK-TIME kill-switch read from a 10s cache, taking 3 freeze reads per tool call down to 1 (plus one on the first call of a window); the pre-execute gate is untouched and still reads the store, so a freeze landing during the judge's window still refuses the dispatch, and any fresh read — this guard's own `freeze()`/`unfreeze()` included — refreshes the cached value. The grants list now carries `refs: { subject, tool }`, so the routed door maps the ref to an indexed column and the whole-drawer page and its JS `continue` are gone; `invalidated` is unaffected, since it only ever collected same-tool grants.

  Sharing the grant read between the preview pass and the real pass was tried and reverted, on a reviewer finding reproduced first as a test: a grant revoked or expired in the gap between the two passes still authorised the tool. A rule is a decision input, but a grant IS the authority the call executes on, so the pipeline reads the grants again for the real pass — park a standing grant on a destructive tool, preview, revoke through the real store, execute, and the guard parks where it used to run. The replay read stays unshared for its own separate reason: a human's yes lands between the two passes and the single-use CAS spend belongs to the real pass.

  A workspace `commit()` is one wire call instead of one per file. It returns early when nothing is staged or removed, and the per-path remove/land passes collapse into a single `commitAll` per owner. Per-entry `expectedRevision` (the null create-only guard included) is preserved and a stale one still refuses the WHOLE commit with `conflict`, and the SQL backend keeps its per-path statements. That last requirement is also a fix: the batched commit applied its deletions before returning `conflict`, so a caller told nothing landed retried against a file that was already gone. The SQL backend now lands every write first and applies tombstones only when no swap was lost, and the façade keeps deletions staged when the commit was refused so the re-apply the conflict branch asks for still carries them. A delete has no compare-and-swap of its own to refuse it, which made an early-applied deletion unrecoverable — true for the whole life of the per-path loop that preceded `commitAll`, and pinned by a test now.

### Patch Changes

- Updated dependencies [88ec7e6]
  - @vendoai/core@0.18.0

## 0.17.0

### Patch Changes

- 64004b6: Arming asks become visible on every StoreAdapter. The automations arming capture wrote its approval rows to `vendo_approvals` without the `subject`/`status`/`call` refs the guard's ref-filtered feeds query by — repo-shipped stores masked it (the reserved table derives those refs from the row itself), but a generic or cloud-hosted records store honors exactly what a writer passes, so the asks were counted by `pendingGrants` yet invisible to `GET /approvals` and immune to the guard's abandoned-ask sweep: an automation card "waiting on N permissions" with nothing to decide, forever. Core now exports `approvalRecordRefs` as the one refs contract for the collection's writers; the guard's park delegates to it; the automations capture stamps it on mint, keeps it across the consume flip, and re-stamps it when arming adopts a pre-contract pending ask — so re-enabling an automation heals rows minted before the fix.
- 1865bdd: Two round trips become one, and a Cloud connection survives the gap between tool calls.

  Every guard decision paid its two bookkeeping lookups — is there an approved
  replay for exactly this call, and is there a matching standing grant — strictly
  one after the other, even though they read different collections and neither
  consults the other's answer. They now go out together. Precedence is untouched:
  the replay verdict is still read first, the grant only after it, and the
  single-use CAS spend still happens exactly once. Against a Cloud-hosted store
  the pair's p50 drops from ~400ms to ~250ms.

  Separately, the Vendo Cloud adapters (`hostedStore`, `cloudSandbox`,
  `cloudConnections`, `cloudTools`) had no connection pooling of their own, so
  they inherited Node's stock dispatcher — which drops an idle keep-alive socket
  after about four seconds. That is shorter than the gap between two of an
  agent's tool calls, so nearly every Cloud round trip paid a fresh TCP+TLS
  handshake: measured against console.vendo.run, five reconnects in five calls
  across a six-second idle gap. Their default `fetch` now rides one shared pool
  that holds a connection for a minute — zero reconnects across the same gap, and
  ~85ms off an after-idle store read. A host passing its own `fetch` still wins,
  exactly as before, and the pool is Node-only by construction: an edge/Worker
  target that cannot load undici keeps today's plain fetch.

- Updated dependencies [c17d492]
- Updated dependencies [64004b6]
- Updated dependencies [85fc732]
- Updated dependencies [8ded5cc]
  - @vendoai/core@0.17.0

## 0.16.0

### Patch Changes

- @vendoai/core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [b57df06]
  - @vendoai/core@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [954ad09]
  - @vendoai/core@0.14.0

## 0.13.0

### Patch Changes

- 9034bcc: guard's own drawers ride the `engine` family

  Approvals, grants, the audit log, the effect ledger, the freeze switch and the
  one-time transition receipts all reached the store through the generic
  `records.*` door a host uses for its own rows. They now go through
  `ops.engine.*` — the same seven verbs, the same collections, the same order,
  with the allowlist gate in front of every one of them.

  `createGuard` takes an optional `ops: StoreOps` beside `store`, threaded from
  the composition. Unset (a `StoreAdapter` with neither its own ops nor a SQL
  handle — every BYO adapter), the same seven verbs are served off the adapter's
  own record doors, gate included.

- Updated dependencies [395fc1e]
- Updated dependencies [031195f]
  - @vendoai/core@0.13.0

## 0.12.0

### Patch Changes

- @vendoai/core@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [5c8043d]
- Updated dependencies [e58520e]
- Updated dependencies [863dc53]
  - @vendoai/core@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [e2128aa]
- Updated dependencies [0e51585]
- Updated dependencies [361f9b9]
- Updated dependencies [b0a165c]
- Updated dependencies [e87a765]
- Updated dependencies [79d7088]
- Updated dependencies [89b4444]
- Updated dependencies [0f46e44]
- Updated dependencies [61b75bd]
  - @vendoai/core@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [18c77cd]
  - @vendoai/core@0.9.0

## 0.8.1

### Patch Changes

- 2ab4a39: Two guard fixes. `previewCheck` no longer spends the single-use approval it was only inspecting: the pipeline now knows whether the caller is committing, so a preview reports that an approved replay exists without claiming its `consumed:<id>` receipt, and the real dispatching check that follows claims it — once, atomically, exactly as before. Previously a previewed call with a stable id answered "run", burned the human's tap, and then parked a fresh approval when the real call arrived, so the call never executed. And `sweepExpiredApprovals` now queries the pending set instead of paging every approval ever decided and filtering in JS — that read ran every 60 seconds per process and grew without bound.
- 2b49b64: `bind().execute` keeps the decisions and hands the dispatch to a `#runOnce` private method: the grant the call runs under, the effect key, the in-flight share and the receipt write all sit together now, and the door above them reads as the four things it decides. No public surface changed, no behaviour changed, and no test changed.
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

- 05ac24c: **BREAKING:** `createVendo`'s config says one thing once. `guard()` is a value,
  prose has one name, connectors are one list, and the `agent:` grab-bag is gone.

  Four incoherences, one shape each. The guard was constructed invisibly from
  three flat keys while `agent()` next door took a guard INSTANCE. `brief` and
  `agent.instructions` were the same prose under two names. `connectorApps` was a
  modifier of `connectors` that was silently ignored whenever `connectors` was
  set. And `agent:` was a bag holding a whole agent OR seven unrelated knobs, half
  of which configured a thinker that never saw them.

  | Removed                    | Replacement                           |
  | -------------------------- | ------------------------------------- |
  | `policy`                   | `guard: guard({ policy })`            |
  | `judge`                    | `guard: guard({ judge })`             |
  | `approvals`                | `guard: guard({ approvals })`         |
  | `brief`                    | `instructions`                        |
  | `agent.instructions`       | `instructions`                        |
  | `connectorApps: ["gmail"]` | `connectors: ["gmail"]`               |
  | `agent.toolOutputCap`      | `toolOutputCap`                       |
  | `agent.maxInitialTools`    | `maxInitialTools`                     |
  | `agent.loadout`            | `loadout`                             |
  | `agent.maxSteps`           | `harness: vendo({ maxSteps })`        |
  | `agent.historyWindow`      | `harness: vendo({ historyWindow })`   |
  | `agent.maxOutputTokens`    | `harness: vendo({ maxOutputTokens })` |

  - **`guard` is one slot with two arms.** `guard({ policy, judge, approvals })`
    from `@vendoai/guard` (re-exported by `@vendoai/vendo/server`) declares the
    host's RULES and lets composition finish them with the plumbing only a venue
    has — the store, the app/service risk resolver, the org-policy layer, the
    cloud policy fallback. A built `VendoGuard` is taken verbatim instead
    (adapter rule). `agent({ guard })` in `@vendoai/agents` accepts the same
    union. `createGuard` is still the one constructor both arms end at; the
    guard's runtime behaviour is untouched, and its own suites pass unmodified.
    `CreateGuardConfig` now also takes `approvals.parkedCallTtlMs` and the guard
    exposes the resolved value at `guard.approvals.parkedCallTtlMs`, so a host
    that brings its own instance keeps the knob instead of losing it.
  - **One prose story.** `instructions` is what this product is, who uses it, and
    the house voice, placed in the assembled prompt's Product section every turn
    — the programmatic override for `.vendo/brief.md`, which `vendo init` still
    writes and still feeds this key. THE ONE BEHAVIOUR DIFFERENCE: prose that
    used to arrive through `agent.instructions` was appended as the LAST section
    of the system prompt, after the guard's directions and the component catalog;
    it now rides the Product section near the top, where `brief` always did.
    Every deployment whose prose came from `brief`/`.vendo/brief.md` — which is
    every deployment `vendo init` scaffolded — gets a byte-identical prompt.
  - **Connectors are one list.** `connectors?: readonly (string | Connector)[]`.
    A string names a Vendo Cloud toolkit and scopes the composed
    cloudTools/cloudConnections pair to exactly that set; an object is an
    explicit provider, used verbatim; mix freely. Strings with no `VENDO_API_KEY`
    mount nothing and the connect surface refuses by naming both fixes — the old
    key's silent-ignore trap cannot survive, because there is no longer a second
    list to ignore.
  - **The knobs split by owner.** What the deployment curates is composition's
    and sits at the top level (`toolOutputCap`, `maxInitialTools`, `loadout` —
    the bridge and the discovery rail are built here and handed to BOTH
    thinkers). What the thinker decides rides the thinker (`maxSteps`,
    `historyWindow`, `maxOutputTokens` — already `vendo()` deps).
    `agent?: ComposedAgent` now means exactly one thing: the agent `agent()`
    built, adopted whole. `instructions` joins `harness`/`store`/`files`/`sandbox`
    as a slot the adopted agent owns, so filling it twice is a boot error.

  `createVendo` REFUSES to compose against a removed key, naming its replacement.
  TypeScript already rejects every one of them; the boot error is for the
  JavaScript host, where a dropped `policy` would mean an unconfigured guard
  running wide open.

- 8d623ec: Connector discovery uses the broker's own search; execution stays ours.

  `search_connectors` searched a local keyword index and then EXPANDED a matching
  toolkit server-side, expecting the client to re-list via
  `notifications/tools/list_changed`. Measured live, Claude Code's agent SDK
  registers no list-changed handler for an HTTP MCP server — exactly one
  `tools/list` per session — so a tool the model had just found was uncallable for
  the rest of that session. The shape is one the industry has abandoned (GitHub
  removed `--dynamic-toolsets`; Composio, whose catalog this is, never shipped it).

  Three permanent tools replace it, so the listing never changes and callability
  never depends on a re-list. They are ordinary registry tools, so they work on
  both the `vendo()` and `claudeCode()` harness paths:

  - **`find_service_tools(need)`** — the connector's OWN search. Each match
    carries the callable slug, the full input schema, the caller's connection
    status and the broker's next-step message, inline, so the model can construct
    a call with no second lookup. A match the broker has no schema for says so
    rather than inviting a guess. The answer is bounded by its own SERIALIZED
    size, under the turn's `agent.toolOutputCap`, so it can never be the result
    that cap truncates: broker schemas are kilobytes each (Composio's run 5–7KB),
    and a result cut at a character count loses a schema mid-object with nothing
    saying which match lost it. Matches are included whole, in the broker's
    relevance order, until the budget is spent; whatever is left over is reported
    as `moreMatches` (a count) and `moreMatchesNote` (narrow the `need` and search
    again), never dropped silently. A single schema larger than the whole budget
    still returns its row, with the same `schemaUnavailable` marker that already
    sends the model to ask rather than guess.
  - **`use_service_tool(slug, arguments)`** — looks up the broker's per-tool risk
    tag, maps it to a `RiskLabel`, lets the guard decide run/ask/refuse, executes,
    and lands on the audit trail with its toolkit named — the same guarded path a
    `host_*` call travels. An untagged tool is `ungraded` (ask-by-default); risk is
    never inferred from a tool's name.
  - **`list_connections`** — unchanged, re-backed by the connector's connection API.

  The Composio adapter also trims the documentation Composio ships for PEOPLE
  inside the machine schema — `examples`, `human_parameter_name`,
  `human_parameter_description` — before a schema reaches the model. It is a third
  of the bytes and none of it is needed to construct a call (measured against
  their live catalog 2026-08-03: eight email matches, 36,407 chars whole, 24,736
  trimmed), so trimming is what lets a realistic search come back complete instead
  of short. Only KEYWORDS are removed: a parameter named `examples` is an
  argument, and survives.

  Both new tools exist only when a connector adapter can actually serve them
  ("no adapter, no tool"): `find_service_tools` and `use_service_tool` need a
  connector implementing the new capabilities, `list_connections` needs only a
  configured connector.

  **The Composio adapter's tool plane now speaks one API version, so a tool the
  search finds is a tool that runs.** Discovery is Composio's tool-router, which
  exists only at `v3.1`; execution and the `apps`-scoped listing were still on
  `v3`. Those are two different catalogs, not two doors onto one — so the model
  would find a slug and the executor would answer `Tool <SLUG> not found`, an
  opaque connector error rather than a connect card or a hint to search again.
  Live-measured against their catalog 2026-08-03, 19 of the 42 slugs a `v3.1`
  search returned for eight ordinary needs did not exist on `v3` at all: every
  Outlook mail and calendar action (`OUTLOOK_SEND_EMAIL`, `OUTLOOK_CREATE_DRAFT`,
  `OUTLOOK_SEND_DRAFT`, `OUTLOOK_CALENDAR_CREATE_EVENT`), every `COMPOSIO_SEARCH_*`,
  five `TEXT_TO_PDF_*`, `GOOGLECALENDAR_EVENTS_GET` and
  `WEATHERMAP_GEOCODE_LOCATION`. It only stayed hidden because Gmail and Slack
  happen to exist in both. Connector tools that used to fail now run.

  The skew ran the other way too, so the listing moved with the executor: `v3`
  carries legacy names `v3.1` has renamed (`OUTLOOK_OUTLOOK_CREATE_DRAFT`,
  `COMPOSIO_SEARCH_NEWS_SEARCH`), and a `v3` listing feeding a `v3.1` executor
  breaks identically. An `apps`-scoped host therefore sees the larger, current
  `v3.1` catalog — Gmail goes from 23 tools to 63, Outlook from 43 to 305 — and
  more of those tools arrive `ungraded`, which is ask-by-default.

  Connected accounts and auth configs stay on `v3` deliberately: live-verified
  identical on both versions, and that plane has no catalog to skew against.
  Both versions are named in one constant each at the top of the adapter.

  **Removed public surface.** All of it existed to serve lazy expansion:

  - `@vendoai/core`: `ToolListingContext.listingScope` and
    `ToolRegistry.releaseListingScope`. A listing no longer has to be identified —
    every tool a run may call is on every listing that run is given.
  - `@vendoai/actions`: `Connector.discoveryIndex`, `Connector.expandToolkits`,
    the `ToolkitIndexEntry` type, `ActionsRegistry.expandToolkits`, the `ctx`
    parameter of `ActionsRegistry.search`/`loadoutSeed`, and
    `ToolSearchOptions.maxExpansions`. `ActionsRegistry.loadoutSeed` now answers
    with every loaded tool and ignores its `connectedToolkits` argument: the
    argument only ever filtered lazily expanded connector tools, and there are
    none. New in their place, all optional:
    `Connector.searchTools`, `Connector.toolRisk`, `Connector.executeSlug`, and the
    `ServiceToolMatch` type. `Connector.toolkitOf` is unchanged — the pre-guard
    connect check still rides it.
  - `@vendoai/agent`: `CONNECTOR_DISCOVERY_TOOLS` now names the three tools above;
    the discovery registry's ports changed shape with them.
  - `@vendoai/mcp`: the door no longer advertises `tools.listChanged`, no longer
    diffs its listing around a call, and no longer keeps a per-session
    notification-replay flag.
  - `@vendoai/vendo`: the `maxSearchExpansions` handler option.

  **Known gap, deliberately not papered over.** A connector that cannot search
  gets neither new tool, and the zero-key Vendo Cloud connector has no search
  backend today — so a Cloud-default deployment that does not scope
  `connectorApps` reaches connectors through the connect dock only until the
  console broker exposes a search endpoint. Filling that with keyword scoring or
  name-based risk inference is exactly what this change removes.

  **Automations can run connector tools, through the consent they already use.**
  `use_service_tool` is one tool name standing in for the broker's whole catalog,
  so its descriptor cannot carry a real grade — it is `ungraded`, and design §12
  withholds `ungraded` from an unattended run the same way it withholds
  `destructive`. Left there, arming an automation on a connector would have been a
  narrowing: before this wave an individually-graded `read` connector tool WAS
  offered to an automation.

  The fix reuses declare-then-accrete consent rather than inventing a mechanism.
  An automation's steps declare the service actions they will call; the person
  arming it approves those specific actions, in the enable card they already see;
  the unattended run may then call exactly those slugs.

  - **`@vendoai/core`**: `GrantScope` gains a third member,
    `{ kind: "service-tool", slug }` — the missing middle between "this whole
    tool" (twenty thousand actions on this one name) and "this exact payload"
    (useless on the next run). Plus `USE_SERVICE_TOOL`, `serviceToolSlug`,
    `serviceToolPhrase`, `withResolvedRisk`, and `RiskResolver` (moved here from
    `@vendoai/guard`, which re-exports it unchanged).
  - **`@vendoai/guard`**: a `service-tool` grant matches a call by its slug.
    `tool` and `exact` grants are untouched, and nothing attended mints the new
    scope, so chat behaviour is unchanged.
  - **`@vendoai/automations`**: `AutomationsConfig.resolveRisk` — the SAME
    resolver the composition gives the guard. Arm-time capture grades a declared
    connector call with it, so the consent card states the grade the call will
    really run under and the grant it mints carries the descriptor hash the guard
    recomputes at fire time. Capture is per service action, and its consent
    sentence names the action in a person's words ("Allow "Morning digest" to
    fetch emails in Gmail while you're away").
  - **`@vendoai/ui`**: a consent row for a connector permission reads as its
    service action with the service's own logo, instead of "Use an outside
    service" once per row.

  What did NOT change: §12 still withholds the dispatcher from every unattended
  listing, and a granted service action the broker grades `destructive` is still
  refused away — the same answer a granted `host_*` send has always got.

  **Second known limit.** An agentic automation declares no slug, so it captures
  no connector grant at arm time: its connector calls park at fire time and
  accrete a per-slug grant when a person approves them. The alternative would have
  been a tool-wide grant on the dispatcher, which is the whole catalog behind one
  card.

- a5293af: The freeze flag: one switch that stops every call.

  `guard.freeze(by)` writes a single row — `freeze` in the guard's own
  `guard:controls` collection — and `#checkWithMetadata` reads it before anything
  else. While it is set, every check comes back
  `{ action: "block", decidedBy: "frozen" }`: a declared read, a call a standing
  grant authorizes, an approved replay. Nothing is spent on the way — no risk
  resolution, no breaker slot, and no parked approval left behind for someone to
  answer later. `guard.unfreeze(by)` lifts it and `guard.frozen()` reads it.

  It is a ROW and not a config field on purpose: the moment you need a kill switch
  is the moment you cannot redeploy to get one. The console flips the same row
  directly through the store, and a guard in another process obeys it on its very
  next check.

  Both directions land on the audit trail as `policy-decision` events naming who
  flipped the switch, and every call the freeze refused is audited exactly as any
  other block is. `@vendoai/core`'s `GuardDecision` block arm and `AuditEvent`
  gain the `"frozen"` provenance (schemas included).

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

- 215bfcc: Harden the turn loop: one turn id everywhere, a token budget instead of a message
  count, a stated retry budget with ordered failover, an extensible stop array, and
  the supervisor slot.

  Every part of this is the shipped loop doing more, not a second loop beside it.

  - **Turn id on both routes.** `mintTurnId` had exactly one call site — the harness
    runtime — so a deployment whose store cannot serve harness turns (a host's own
    non-SQL adapter, the Cloud hosted store) wrote audit rows that named no turn.
    `createAgent` now mints on the same terms, onto the `RunContext` every guarded
    call and audit mint already holds. An id the caller already minted wins.
  - **Token-budgeted compaction.** `context.contextTokenBudget` bounds the PROMPT
    rather than the message count, shedding reasoning, then old tool payloads, then
    the oldest messages — via `pruneMessages`, which drops a tool call together with
    its result so the prompt stays well-formed however much it sheds. The size is a
    documented chars/4 estimate; `historyWindow` is unchanged.
  - **The knobs reach both thinkers.** `vendo()` built its context only when a
    `maxSteps` existed and put only `maxSteps` in it, so a host's `agent:` history
    window was silently ignored on the DEFAULT route. `VendoHarnessOptions` and
    `VendoHarnessDeps` now carry `historyWindow`, `contextTokenBudget` and
    `maxOutputTokens`, the whole context is passed, and `createVendo` forwards the
    host's `agent:` block to the harness it composes.
  - **Retries and failover.** `context.maxRetries` is explicit against
    `DEFAULT_MAX_RETRIES` (the SDK's own value, so nothing changed but ownership).
    `fallbacks` takes the rungs below the primary model and is tried in order when a
    provider fails BEFORE producing output; once output streams there is no
    failover, because a mid-stream switch would emit a second answer on top of half
    a first one. Cancellation is the only thing classified, and the last rung's error
    is rethrown untouched, so the wire error gate is unchanged.
  - **`stopWhen` is extensible.** `createAgent`'s `stopWhen` composes with the loop's
    own three conditions; `tokenBudgetStop(n)` is the shipped per-tenant ceiling and
    is exported publicly. Opt-in — unset, a turn runs exactly as it did.
  - **Supervisor slot, shipped as a no-op.** `createAgent`'s `supervise` gets the
    turn id, the final answer and the `RunContext`, and a refusal travels the failure
    path a turn already has (`wireErrorMessage`, the same `error` chunk, the same
    recorded notice). Unset costs a turn nothing.

- 10a2b44: An approval now reaches ONLY the conversation that parked it.

  Every `agent().session()` subscribed to the shared guard's
  `onApprovalRequested` unscoped, so a guarded action parked in one
  conversation surfaced in every other session's `on("approval")` handler —
  another user's pending action, preview included, with live approve/deny
  closures. The subscription was also never released, so a dead session's
  callback outlived it on the guard.

  The guard has always recorded the parking conversation
  (`ApprovalRecordData.sessionId`, from `RunContext.sessionId`); that identity
  now rides the emitted request too (`ApprovalRequest.ctx.sessionId`, optional
  only for rows persisted before it existed). Sessions deliver a request to
  their handlers only when it names their own thread — an ownerless request
  matches none, failing closed — and the guard subscription is taken on the
  first `on()` handler and released with the last. Deciding an approval was
  and remains owner-scoped: a foreign principal's decide is `not-found`.

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

- f95feb7: Runtime/generation wave: `apps.pipeline` threading through createVendo, `agent.instructions` host-voice seam, per-instance judge model binding (bindVendoModelSlots — the process-level slot registry is gone; `Judge.model` is now part of the guard's Judge contract), island-scoped repair + concurrent tier-0 paint lane with a monotonic partial gate, region-parallel assembly compiling the production inline-reference dialect, smoke-render environment failures skipping instead of failing apps, no-emoji contract rules, and per-lane generation logging (onTiming/onPipeline wired to the operator console).

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

- 4b8ac66: Per-user connected accounts via the Composio broker (ENG-262). Connectors gain a subject-scoped `connections` capability (list/initiate/status/disconnect); the umbrella serves per-principal `/connections` endpoints with a Vendo Cloud broker seam behind `VENDO_API_KEY`; a Composio call missing a connection returns the new typed `connect-required` tool outcome, rendered by `VendoThread` as an inline connect card that retries after connecting; `ConnectedAccountsPanel` (list + disconnect) joins the chrome as the accounts tab. Composio tools carry curated risk (metadata hints + slug patterns) instead of a blanket `write`; the MCP connector accepts an async per-principal `headers` resolver with per-subject sessions; every connector execution is audited with its account identity.

### Patch Changes

- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.
- Updated dependencies [49e9ccc]
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [fa0ad98]
- Updated dependencies [51f3fc9]
- Updated dependencies [ff6b5d5]
  - @vendoai/core@0.4.0
