# @vendoai/actions

## 0.15.0

### Patch Changes

- Updated dependencies [9e0ed9a]
- Updated dependencies [b57df06]
- Updated dependencies [b324b79]
  - @vendoai/apps@0.15.0
  - @vendoai/core@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [954ad09]
  - @vendoai/core@0.14.0
  - @vendoai/apps@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [395fc1e]
- Updated dependencies [031195f]
  - @vendoai/core@0.13.0
  - @vendoai/apps@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [0d67885]
  - @vendoai/apps@0.12.0
  - @vendoai/core@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [5c8043d]
- Updated dependencies [eeebbee]
- Updated dependencies [402e7ad]
- Updated dependencies [a216b68]
- Updated dependencies [e58520e]
- Updated dependencies [863dc53]
  - @vendoai/core@0.11.0
  - @vendoai/apps@0.11.0

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

- b0a165c: Remix is a seeded app: the pins subsystem is gone

  An app that was made from one of your components no longer carries a list of
  "pins". It carries a single `seed` — the component it started from and the
  version of that component it started at. A remix is an ordinary app that
  happens to start from something, so it is created, validated, edited and
  versioned through exactly the same doors as every other app.

  **Behaviour change you will notice: updating a remix now replaces it.**
  When the host component changes, the remix reports drift as a warning and
  nothing happens on its own. If you choose to update, you get the pristine new
  component — the edits you made to that component are replaced. The previous
  release replayed your recorded edits on top of the new version; that machinery,
  its preflight and the version trail feeding it are deleted. Drift is a warning,
  and updating is always your choice. The UI says this in the drift banner, and
  the agent tool's description tells the model to say it too.

  **Behaviour change on admission.** Every write path now runs the same document
  validation, seeded and forked apps included. Seeded bundles used to skip the
  island gate entirely, so a capture the jail could never render was accepted
  without complaint. Captures that produce invalid documents will now be refused.

  **Fixed.** A seeded app whose host component had moved on used to open with no
  imports, no sub-modules and no styles — silently. Those furnishings were
  hash-matched against the live baseline at open time, so any drift lost them.
  They now travel inside the stored component bundle. Separately, artifact export
  dropped remix provenance because the interchange field whitelist never listed
  it, so export-permission checks never ran.

  **Renames.**

  - `AppDocument.pins?: Pin[]` → `AppDocument.seed?: AppSeed`
    (`{ component, baseline, slot?, review? }`). `Pin` and `pinSchema` are removed;
    `AppSeed` and `appSeedSchema` replace them. `forkedFrom` is unchanged.
  - `AppsRuntime.pins.{fork,rebase}` → `AppsRuntime.seed.{from,reseed}`, plus
    `seed.drift`. `seed.from({ component, slot?, instruction? })` and
    `seed.reseed({ appId })` both return the `AppDocument`.
  - `pinComponentName` → `seedComponentName`; `PinBaseline`/`pinBaselineSchema` →
    `SeedBaseline`/`seedBaselineSchema`; `AppsConfig.pinBaselines` →
    `seedBaselines`; `detectPinDrift` → `seedDrift` (one seed, so it returns one
    `SeedDrift` or `null`); `ScreenPinDrift` → `ScreenSeedDrift`.
  - `EditResult.driftedPins?: PinDrift[]` → `EditResult.seedDrift?: SeedDrift`;
    the tree payload's `pinDrift` array → a single `seedDrift`.
  - HTTP: `POST /apps/fork-pin` and `POST /apps/:id/fork-pin` → `POST /apps/seed`;
    `POST /apps/:id/rebase-pin` → `POST /apps/:id/reseed`.
  - Client: `apps.forkPin(...)` → `apps.seedFrom({ component, slot?, instruction? })`;
    `apps.rebasePin(id, slot)` → `apps.reseed(id)`.
  - Agent tool `vendo_apps_rebase_pin` (appId + slot) → `vendo_apps_reseed` (appId).
  - `@vendoai/actions` no longer declares its own `CapturedPinBaseline`; the one
    shape lives on `@vendoai/apps/contract` and actions re-exports it as
    `SeedBaseline` / `seedBaselineSchema`.
  - `PinForkInput`, `PinForkResult`, `PinRebaseResult` and `PinDrift` are removed.

  Seeding into an app that already exists is gone: the gesture always mints an
  app, because a seed is the provenance of a whole app rather than a row added to
  one. The generated component name stored inside documents is deliberately
  unchanged, so apps already on disk keep working.

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

- 4772c49: Two actions fixes and a public-surface trim. A failed MCP handshake is no longer cached for the process lifetime: `mcpConnector` clears the memoized `initialize` promise (and the session id) when it rejects, so one transient blip no longer permanently kills every tool that connector serves. The registry's documented evict-on-rejection retry re-entered the same rejected promise and silently never recovered. Component capture now checks the closure byte budget before it walks imports as well as during: an entry file with no capturable host-local import used to be written at any size, so an oversized single-file component reached `.vendo/components/` in violation of the one-total-budget guarantee. Finally, `validateCapabilities`, `CapabilityIssue` and `PrimitiveStepTarget` are no longer re-exported from the package root — they are internal to the compound walker and had no consumer outside it.
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

- 4ec9c17: Decompose the ten highest cognitive-complexity functions in `@vendoai/actions`
  into named helpers alongside them. Internal restructuring only — no public
  surface changed, no behaviour changed, and no test file was touched.
- 3e2b35e: GraphQL extraction is gone. The advertised extraction tier is four stacks: OpenAPI, route-scan, tRPC, Next.js server actions.

  The GraphQL extractor was ~2.2k lines — SDL parsing, `@nestjs/graphql` and
  `type-graphql` code-first resolver walking, endpoint discovery, document
  generation — and its only real-world corpus host emitted _every_ operation
  `disabled` by design, because static analysis cannot attribute an operation to
  one of several schema endpoints. A stack we could detect but never usefully
  extract is worse than one we never mention, so the detection went with it.

  Removed with it: the `graphql` binding kind in `vendo/tools@3` (`GraphqlBinding`,
  `graphqlBindingSchema`), its slot in the tool-identity rule, and the GraphQL HTTP
  transport in the runtime registry. This is breaking for a host whose committed
  `.vendo/tools.json` already carries a `graphql` binding — that file no longer
  parses. Pre-1.0, no deprecation shim ships; re-run `vendo sync` to regenerate.

  Route-scan skips a GraphQL endpoint instead of falling back to it. A Next.js
  GraphQL handler exports `POST` like any other route, so generic scanning would
  mint an enabled tool that posts the model's arguments as the JSON body — which
  every GraphQL server rejects, since it wants a `{ query, variables }` envelope.
  The endpoint now yields no tool and a warning naming it. Cut means gone, not
  gone-and-quietly-worse. Detection reads every module the verb scan already
  resolves — the route file plus the local re-exports it follows — so a handler
  kept in a separate file is skipped too. A route that merely _imports_ a GraphQL
  server and wraps it in its own exported handler is still scanned generically;
  disable that tool through `overrides.json`.

  Behaviour for the four surviving stacks is unchanged.

- d4a2d4c: Sync's scanners stop inventing a delete and stop discarding a props schema.

  A `pages/api` handler that switches on a body discriminant —
  `switch (req.body.action) { case "delete": ... }` — had every string case clause
  counted as an HTTP method, and the verb is upper-cased before it is checked. The
  scan handed the agent an ENABLED, `destructive`-graded DELETE tool bound to the
  route's real URL for a delete the handler never implements, and because any verb
  evidence short-circuits the `req.body` inference below it, that phantom verb
  _replaced_ the POST the route actually serves. Only an uppercase verb literal
  counts now.

  Separately, the component catalog scanner failed a whole props object as soon as
  one property could not be converted, so a component with a single callback,
  `ReactNode`, or npm-typed prop published `propsSchema: {}` for every prop — and
  the console then told the host it had declared no props schema at all. One
  unrepresentable property now degrades to a permissive `{}` and drops out of
  `required`, the same rule the route input converter already applies, so every
  prop that converted fine reaches the catalog and previews can draw from them.

- 2357b22: The setup surface: declared URLs, one join law, a VendoProvider-only surface, and `init` = install + the shared sync flow.

  **Breaking: `VendoRoot` is removed. Use `VendoProvider`.**

  ```diff
  -import { VendoRoot } from "@vendoai/vendo/react";
  -<VendoRoot components={registry}>{children}</VendoRoot>
  +import { VendoProvider } from "@vendoai/vendo/react";
  +<VendoProvider baseUrl="/api/vendo" components={registry}>{children}</VendoProvider>
  ```

  That is the whole migration: the props are identical, and `baseUrl` is the wire
  mount with your deployment's path prefix included (default `/api/vendo`).
  `npx vendo doctor` names the swap and the file if you miss one (`E-WIRE-010`).

  **Breaking: `VENDO_BASE_URL` is the app's FULL public URL, path prefix included.**

  Set it to `https://site.com/maple`, not `https://site.com`. Nothing strips its path
  any more: host tool calls, login redirects and box callbacks all hang off it, each
  attaching the prefix exactly once through one helper in `@vendoai/core`. Two new
  optional overrides: `VENDO_HOST_API_URL` (the host API on another origin) and
  `VENDO_LOGIN_URL` (the login page, which may be on another domain).

  Stored tool paths in `.vendo/tools.json` are now **prefix-free** — run `vendo sync`
  once to regenerate them. This closes #866 (login redirect drops the base path),
  #867 (returnTo double-prefix) and #914 (host tools 404 under a path prefix). When the
  client and the server disagree about where the wire is mounted, the browser now gets
  one loud named error instead of a mysterious 404, and `vendo doctor` catches an
  OpenAPI server mount that disagrees with `VENDO_BASE_URL` (`E-CFG-003`).

  **`vendo init` no longer generates `vendo/registry.tsx` or `vendo/vendo-root.tsx`.**

  It scaffolds the server route handler and prints one paste: `<VendoProvider>` around
  your client root. If you have host components, you write one small `"use client"`
  file yourself — see the quickstart. Existing generated files are untouched; they are
  yours now.

  **`vendo init` ends in the same flow `vendo sync` runs.** One extraction, one theme
  path, one consent question, one report — `init` in full mode (a fresh install has
  judged nothing), `sync` incremental. `init` now reads `.env` as well as `.env.local`,
  so a model key that lives in `.env` is no longer invisible.

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

### Patch Changes

- cfacf95: Security floor for `@auth/core`: the optional peer range moves from `^0.34.3`
  to `>=0.41.3`. The `authJs()` presets pass the raw incoming request to the
  host's `getToken()`, and `@auth/core` versions before 0.41.3 have a
  request-triggered CPU-exhaustion DoS in that call. 0.41.3 is the patched
  release; hosts on older Auth.js should upgrade `@auth/core` alongside this.
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

### Minor Changes

- 89153f8: Delete the pre-v3 `.vendo` format layer and the semantics dev-server pass.

  `.vendo/` is now one format, not two. The `vendo/tools@1` / `vendo/overrides@1`
  schemas, `vendo/capabilities@1`, `vendo/semantics@1`, `vendoFileVersion`, and
  every dual-format reader and in-memory migration fold are gone; the surviving
  `@3` names lost their `V3` suffix (`toolsFileSchema`, `overridesFileSchema`,
  `ExtractedTool`, `OverridesFile`, `VENDO_TOOLS_FORMAT`, `VENDO_OVERRIDES_FORMAT`
  — now exported from `@vendoai/actions`, and the persisted tag strings
  `"vendo/tools@3"` / `"vendo/overrides@3"` are unchanged).

  `vendo sync` also no longer calls a running dev server to infer field
  semantics: the `POST /sync/semantics` route and its CLI pass are deleted, so a
  sync never executes host endpoints as a side effect. The per-tool `semantics`
  field itself is untouched — sync's AI enrichment proposes it and
  `overrides.json → tools[name].semantics` still wins forever.

  Removed public types: `CapabilitiesFile`, `SemanticsFile`, `OverridesFileV3`
  (use `OverridesFile`). Removed config: `createActions({ capabilities })`,
  `createVendo({ profile: { capabilities, semantics } })` — compounds and briefs
  live in `overrides.json`.

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

- 127aa29: Add the judgment layer's core: `.vendo/judgments.json` and the direction rule.
  Remove the `watermark` and `enriched` fields and the restrictive-only clamp they
  served.

  `.vendo/` gains a THIRD file, split from the other two by author the same way
  `overrides.json` is: `vendo/judgments@1` (`judgmentsFileSchema`,
  `JudgmentsFile`, `ToolJudgment`, `JudgmentFields`, `PendingLoosening`) is where
  the model writes. Every entry costs a quoted piece of handler evidence —
  `evidence` is required and length-bounded at both levels, and a malformed file
  fails loudly at parse rather than being ignored, because it can carry disables.

  The new `@vendoai/actions` root exports replace the old clamp:

  - `classifyField(tool, field, value)` — "harden" or "loosen". Risk up, audience
    narrowed, `disabled: true`, `critical: true` harden; the inverses loosen.
    Prose and semantics route with the hardenings.
  - `splitProposal(tool, proposal)` — hardenings apply; loosenings are QUEUED as
    `pending` with their own evidence instead of being refused and forgotten, and
    wait for a human. Direction is computed against the tool's effective state
    (skeleton ⊕ the standing judgment), so judgments only ever ratchet tighter.
  - `applyJudgment(tool, judgment)` — inert when the judgment's `binding` no
    longer matches the tool's identity, so a stale judgment never grades another
    handler. Semantics merge per key; `pending` is never applied; an
    operator/internal audience still composes `disabled: true` (fail-closed).
  - `pruneJudgments(file, tools)`, `RISK_RANK`, `AUDIENCE_RANK`.
  - `bindingIdentity` / `dedupKey` now also ship from the package root (pure, no
    node imports) — writing a judgment means computing a binding identity, and
    the runtime side cannot reach the node-only `./sync` entry.

  Removed: `clampEnrichment`, `applyEnrichmentFields`, `carryEnrichment`,
  `gitTreeHash`, `EnrichmentFields`, `ClampedEnrichment`, and `RISK_RANK` /
  `AUDIENCE_RANK` from `@vendoai/actions/sync` (the ranks moved to the root).
  Removed fields: `ToolsFile.watermark`, `ExtractedTool.enriched`, and the
  `watermark` option on `vendoSync`. The per-tool `semantics` carry across
  structural syncs is unchanged, and so is `ExtractedTool.outputSchema` — a
  declared response shape is not a judgment, and it is load-bearing for
  first-try prop binding (docs/verification/demo-live-readiness/donut-bind).

### Patch Changes

- b14b209: Wire `.vendo/judgments.json` into the runtime read path: the AI layer now
  actually applies, between the machine layer and the human one.

  Host tools compose as `tools.json < judgments.json < overrides.json` — the
  scanner's skeleton, hardened by its standing judgment, then corrected by the
  authored override, which still wins last. `LoadedHost` carries the parsed
  judgments file, and `loadHost` reads it in the same `Promise.all` as the pair.
  Absent is fine; MALFORMED fails loudly at load, the same fail-closed posture as
  `overrides.json` and for the same reason — the file can carry disables and
  audience exclusions, so silently ignoring a broken one would silently loosen the
  live surface.

  Judgments are a HOST-tool layer only: connector, registry, and compound tools
  are untouched. Lane A's safety properties hold on the read path — a `pending`
  loosening never applies, and a judgment whose `binding` no longer matches the
  tool's identity is wholly inert.

  `mergedHostSemantics` gains the matching leg, so generation sees the same three
  layers: `tools.json` semantics, then `judgments.json` `fields.semantics`, then
  the authored overrides. `createVendo`'s host-semantics provider reads
  `.vendo/judgments.json` alongside the pair, live per generation.

  Also fixed: the zero-live-host-tools boot warning derived enablement by hand
  from `overrides.json` alone, so a deployment whose host tools were all disabled
  by judgments would have shipped a silently useless agent without warning. It now
  reads the same effective state the registry dispatches from.

- 5987985: A failed host call now names the origin it called, not just the path.

  `http-error` outcomes were formatted `GET /customers → 404: …`. When a
  deployment's `VENDO_BASE_URL` points at the wrong host, every tool 404s while
  every path is correct — and that message reads exactly like a malformed path.
  It now reads:

  ```
  GET https://api.example.com/customers → 404: no such route
  ```

  The target is assembled from the URL's origin and path only, so a `baseUrl`
  carrying userinfo (`https://svc:pw@host`, `https://ghp_x@host`) or a
  query-string token never reaches an error message, a host log, or the model.

- Updated dependencies [89153f8]
- Updated dependencies [3ae3d13]
  - @vendoai/core@0.6.0

## 0.5.0

### Minor Changes

- f5fbb4b: Make the MCP door presentable: per-surface tool menus, human tool titles, and
  risk-derived MCP annotations.

  Hosts curate what each surface offers from `.vendo/overrides.json`'s new
  `surfaces` block (`agent` and `mcp`, a closed key set so a misspelled surface
  fails loudly at parse). `ActionsRegistry.surfaceMenu()` resolves it: the
  authored list wins, an absent `agent` menu is unrestricted, and an absent `mcp`
  menu falls back to every merged, enabled tool whose `audience` is `end-user` or
  unset. Menus are curation, not security: the guard, `disabled`, and audience
  exclusions are untouched, an off-menu call returns the same not-found an unknown
  tool returns, and a menu entry naming a missing or disabled tool warns once and
  is skipped rather than taking the host down. Vendo's own `vendo_*` runtime tools
  are never curated away on either surface.

  `ToolDescriptor` and `ToolOverride` gain an optional `title`: the short human
  label for surfaces people read. `vendo sync`'s AI enrichment proposes one per
  tool (presentation, so it is exempt from the restrictive-only clamp and carried
  across structural syncs); `.vendo/overrides.json` corrects it. The door emits it
  in both standard MCP places (top-level `title` and `annotations.title`), and
  approval cards prefer it over the prettified tool id, behind an in-code
  `ToolMeta.label`.

  **Upgrade note.** Every tool the door lists now carries `annotations`
  unconditionally, including for hosts with no `surfaces` block. That means a
  `read` tool asserts `readOnlyHint: true` to clients, and some MCP clients use
  that hint to skip their own confirmation prompt for read calls. Nothing changes
  server-side: Vendo's guard, policy, approvals, and audit decide exactly what
  they decided before, and annotations are hints the spec says clients may
  ignore. If you have a `read`-labelled tool that is not actually side-effect
  free, correct its `risk` in `.vendo/overrides.json` — that label was already
  driving your policy.

  Every tool the door lists now also carries `annotations` derived from its risk
  label (`read` → `readOnlyHint`, `destructive` → `destructiveHint`), and the door
  serves a themed, script-free, unauthenticated connect page at `{mount}/connect`
  with the MCP URL and per-client setup steps for Claude, ChatGPT, and Cursor.
  demo-bank ships a curated twelve-tool menu as the worked example.

- 280a142: Generation repair now repoints an array-expecting prop that landed on a `{ data: [...] }` wrapper object, instead of regenerating the whole app. Live on the Maple demo, the most obvious prompt ("Show my spending by category") never rendered: the model bound the donut's `slices` array prop to the spending tool's ROOT object, validation correctly rejected it (`expected an array, the bound field is object`), and — because a kind mismatch is not a compile _binding_ error — structured repair's closed fix space was empty, so every attempt paid a full-lane regeneration. When the bound object holds exactly ONE top-level array, repair now derives the nested path and splices it with no model call; ambiguous shapes (zero or 2+ arrays) keep today's behavior. Any host returning an envelope instead of a bare array hit this.

  `vendo sync` also records a host's DECLARED response body: an OpenAPI 2xx `application/json` schema becomes `outputSchema` on the `.vendo/tools.json` entry (refs resolved), so the envelope a host returns is part of the committed contract rather than something the model infers. Nothing is invented when the spec is silent.

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

- 52c72c2: Doctor judges unknown-framework hosts (Cloudflare Workers, Bun, Hono, ...)
  by their actual wiring instead of Next.js file layout — no more permanent
  E-WIRE-003/004 false positives on custom runtimes (new codes E-WIRE-007/008).
  The tool surface is now graded statically: all extracted tools disabled or
  excluded fails doctor (E-TOOLS-001), an empty surface warns (E-TOOLS-002),
  and the actions registry warns at runtime when the agent composes with zero
  live host tools — the silently-useless-agent failure mode is no longer
  silent anywhere.
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

- 70b59db: Extraction now grades every tool's audience (end-user / operator / internal)
  by reading the handler's own auth checks, and excludes non-end-user tools
  from the embedded agent by default (recorded as `audience` in
  .vendo/overrides.json; human decisions always win). Applying a surface that
  leaves the agent with zero live tools warns loudly instead of shipping a
  silently useless agent. Field origin: an infra product's extraction proposed
  operator/reconciliation endpoints; stripping them by hand left an empty
  toolkit and an agent that couldn't act.
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

- 5d89564: Extract registered host-component catalogs deterministically during sync, persist strict catalog artifacts and stale-safe review-only copy proposals, and load generated catalogs into the umbrella runtime with actionable malformed-file warnings. TypeScript is loaded only on the sync scan path and is no longer a production dependency of `@vendoai/actions`.
- 4b8ac66: Per-user connected accounts via the Composio broker (ENG-262). Connectors gain a subject-scoped `connections` capability (list/initiate/status/disconnect); the umbrella serves per-principal `/connections` endpoints with a Vendo Cloud broker seam behind `VENDO_API_KEY`; a Composio call missing a connection returns the new typed `connect-required` tool outcome, rendered by `VendoThread` as an inline connect card that retries after connecting; `ConnectedAccountsPanel` (list + disconnect) joins the chrome as the accounts tab. Composio tools carry curated risk (metadata hints + slug patterns) instead of a blanket `write`; the MCP connector accepts an async per-principal `headers` resolver with per-subject sessions; every connector execution is audited with its account identity.
- c42d41a: Static GraphQL extractor behind the extractor seam plus an additive `graphql` binding kind in `vendo/tools@1` (ENG-247). Schemas are read statically from SDL files (parsed with the host's own graphql package) and from code-first `@nestjs/graphql` / `type-graphql` resolvers (TypeScript compiler API) — no host code runs. One tool per query and mutation, deterministic `inputSchema` from GraphQL argument types, and depth-limited default selection sets baked into executable documents. Execution POSTs `{ query, variables }` to the host endpoint with auth semantics identical to route bindings; a 200-with-`errors` response surfaces as an http-error outcome. Fail-closed rules: queries earn `read` only with read-shaped names, mutations default `write`, the destructive word list applies unchanged, and subscriptions, statically-unresolvable types, and multi-endpoint hosts are emitted `disabled: true` with a note. Route-scan tools under a GraphQL endpoint are shadowed like tRPC mounts.
- 2f67c65: Server-actions extractor behind the extractor seam (ENG-248): statically scan `"use server"` modules and inline functions with the TypeScript compiler API, interpret zod-validated and annotated inputs into JSON Schema (fail-closed to permissive + note otherwise), and emit the additive `server-action` binding kind (`module` + `exportName` + ordered `params`) within `vendo/tools@1`. Execution is direct in-process registration: `vendo init` now generates a `vendo-actions.ts` registration map wired into `createVendo({ serverActions })`; a server-action tool whose registration is missing fails closed with a clear error and no work performed. Risk labels fail closed — actions default `write`, the destructive word list applies, and unclassifiable or inline (non-importable) actions are emitted `disabled: true` with a note.
- ebc72e4: Runtime tool search and loadout (ENG-252). Add a deterministic `ActionsRegistry.search` query API (plus the pure `searchToolDescriptors`) that ranks the merged, enabled tool surface by intent, excluding disabled tools. The agent gains a `vendo_tools_search` meta-tool: it starts from a bounded initial loadout — the whole enabled surface when it fits the cap, an explicit curated list when provided, otherwise a read-first bounded default (`DEFAULT_MAX_INITIAL_TOOLS`) — and discovers and loads the rest mid-run. Loaded tools persist across turns within a thread and execute through the same guard-bound registry as any initially-enabled tool, so there is no unguarded path. The umbrella wires the search seam to the guard-bound registry.
- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.

### Patch Changes

- Updated dependencies [49e9ccc]
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [fa0ad98]
- Updated dependencies [51f3fc9]
- Updated dependencies [ff6b5d5]
  - @vendoai/core@0.4.0
