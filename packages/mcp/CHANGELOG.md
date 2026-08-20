# @vendoai/mcp

## 0.36.0

### Patch Changes

- Updated dependencies [f325443]
- Updated dependencies [0108715]
- Updated dependencies [0b6bb92]
- Updated dependencies [2c662ac]
  - @vendoai/apps@0.36.0
  - @vendoai/core@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [ea60d95]
- Updated dependencies [ea60d95]
  - @vendoai/apps@0.35.0
  - @vendoai/core@0.35.0

## 0.34.0

### Minor Changes

- 3f7740a: Zero-setup MCP over Vendo Cloud, and one method to mint a user's token.

  The mcp seam gains its Cloud rung, in the shape every other Cloud-backed seam
  already has (`selectConnections`): an explicit `mcp.remoteAs` wins verbatim, the
  declared `VENDO_MCP_BROKER_URL` / `VENDO_MCP_FEDERATION_SECRET` pair wins next,
  then `VENDO_API_KEY` lets the console provision the tenant's broker, federation
  secret and service key, and a keyless deployment stays exactly the local door it
  was. Provisioning is LAZY — composition still does no I/O, so a console outage
  cannot stop a deployment booting; the first discovery hit, door hit or
  `tokenFor` fetches the bundle and the process caches it. A deployment that
  already sets `VENDO_API_KEY` and `mcp: true` moves from a local door to its
  Cloud-brokered one on upgrade; declare the env pair (or pass `mcp.serviceAuth`)
  to keep the door you have.

  `vendo.tokenFor(request | userId)` is the whole new public API: one short-lived
  MCP access token bound to one of your users, so a backend agent connects to your
  door as them, under the same guard and audit trail as the in-product agent. Pass
  the incoming `Request` and the user is read off its session cookie through the
  same seam the door authenticates with; pass an id to mint headlessly. Where the
  exchange happens is the deployment's posture, not the caller's problem — Cloud
  exchanges at the provisioned broker, BYO at the door's own `/token` — so the
  same agent code works against both. A blank or literal `"undefined"` subject is
  now refused, at `tokenFor` and again at the door's token endpoint, naming the
  fix: a token minted for a user nobody is would work perfectly and only fail much
  later, as a tool call that finds no data.

### Patch Changes

- f7e0ff4: A long tools/call now survives an external MCP client's clock. The door emitted
  no progress at all, so a stock SDK client abandoned `vendo_make` at its 60s
  default while the door was still working. The door now beats
  `notifications/progress` for the life of the call — immediately, then every 15
  seconds — but only for a client that asked to be kept alive by sending a
  `progressToken`. Beating is the half the door owns; the client owns the other,
  because the SDK extends its deadline on a progress frame only when the caller
  passed `resetTimeoutOnProgress`, which defaults to false. `your-own-agent` now
  documents both. The beat rides the standalone stream rather than the request's
  own, because the door answers POSTs with `enableJsonResponse` and the transport
  drops a request-related notification when there is no SSE body to write it to.

  Malformed arguments to the `vendo_apps_*` ride-along tools can no longer mint a
  parked approval. Validation ran after the guard, so a call that could never
  execute — `vendo_apps_call` with no `ref`, say — left an approval waiting in the
  queue for a human to resolve. Arguments are now judged first, and a bad one
  comes back as a `validation:` error with no approval and no audit row.

- Updated dependencies [f7e0ff4]
- Updated dependencies [f7e0ff4]
  - @vendoai/apps@0.34.0
  - @vendoai/core@0.34.0

## 0.33.0

### Patch Changes

- Updated dependencies [8c7b476]
- Updated dependencies [9d3f0af]
  - @vendoai/apps@0.33.0
  - @vendoai/core@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies [88cf572]
  - @vendoai/apps@0.32.0
  - @vendoai/core@0.32.0

## 0.31.0

### Patch Changes

- @vendoai/core@0.31.0
- @vendoai/apps@0.31.0

## 0.30.1

### Patch Changes

- Updated dependencies [6bbc8e6]
  - @vendoai/apps@0.30.1
  - @vendoai/core@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [b3d92b2]
- Updated dependencies [bd1d016]
- Updated dependencies [56c81b5]
  - @vendoai/apps@0.30.0
  - @vendoai/core@0.30.0

## 0.29.1

### Patch Changes

- @vendoai/core@0.29.1
- @vendoai/apps@0.29.1

## 0.29.0

### Patch Changes

- Updated dependencies [6bc5cc8]
- Updated dependencies [ebf101a]
- Updated dependencies [0484a15]
- Updated dependencies [df0b4cb]
- Updated dependencies [7e78031]
- Updated dependencies [6bc5cc8]
- Updated dependencies [f06b033]
  - @vendoai/core@0.29.0
  - @vendoai/apps@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies [650e5eb]
- Updated dependencies [0143c4e]
- Updated dependencies [62c8630]
- Updated dependencies [0143c4e]
  - @vendoai/core@0.28.0
  - @vendoai/apps@0.28.0

## 0.27.1

### Patch Changes

- ebe9ffc: A store that will not hold one collection no longer takes the whole deployment down with it.

  0.27.0 on a Vendo Cloud key served 501 to every route. The hosted store's engine allowlist did not carry two of the collections this version reads — `vendo_automations` and `vendo_app_seen` — and the automations one is read at BOOT, by the code-automations reconcile that rides the `ready()` latch. The latch memoizes, so the first refusal became every route's answer for the life of the process: 2.3 seconds for the first request, 3 milliseconds for every one after, all of them 501, including the routes that never touch an automation.

  Three separate faults, and the deployment needed all three fixed:

  The boot reconcile is no longer the deployment. A store that refuses the automations read leaves code-authored automations off and says so once, in a line the operator can act on; everything else serves. Scoped to that one read — every per-request store failure still fails in the open, where the caller can see it.

  The unseen dot costs the dot, never the answer. `vendo_app_seen` was read on the path that LISTS a person's apps and written on every render, so a store refusing that collection took the whole page of apps with it. A refusal is absorbed there now, once per process, and the apps arrive without their arrival dots.

  And `instanceof VendoError` does not survive a realm boundary. A host bundle can carry two copies of `@vendoai/core` — the ESM `dist/` beside the CJS `dist/cjs/` — and the second copy's VendoErrors are a different class with the same shape, so every `instanceof` gate said no. That is why a blocked collection reached the wire's catch-all as an unknown fault and answered "Internal Vendo error" instead of its own 403.

  `isVendoError` is the check that survives it: `name` plus `code`, the two things any of these gates actually read. Every type-gate in the repo takes it now — 48 of them across the eight packages that had one — because the failure was never specific to the wire. The same class of error decided whether a lost compare-and-swap re-aimed or crashed the workspace façade, whether a swept approval rendered "expired" or an error card, whether a host's knowledge adapter got its code named in the operator's log, whether a permission route answered 403 or threw, and whether a build's "busy, try again shortly" read as "generation failed" — a verdict on an ask that was never the problem. `@vendoai/harnesses` proved the duck check first and kept a private copy of it; that copy is now this one function.

- ebe9ffc: Every block binds the host's zod. These four declared zod as a dependency only, while the other seven declared it as both a dependency and a peer of `>=3.25.0 <5` — and the peer is what makes pnpm bind the host's copy. So on a host that resolves zod 4, which `ai`'s own peer range admits, the seven bound the host's zod and the four kept their own: one package set, two zod instances. A schema built in one is not a schema in the other, so `@vendoai/core`'s `riskLabelSchema` inside `@vendoai/guard`'s `z.object` threw `Invalid element at key "risk": expected a Zod schema` and every tool call died before it started (#1314).

  The four now declare the same peer, so there is one zod for all eleven. `scripts/dependency-guard.mjs` gains rule 5 to hold the posture uniform: a published block that bundles zod must declare that exact peer range.

- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [1fb1810]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
  - @vendoai/core@0.27.1
  - @vendoai/apps@0.27.1

## 0.27.0

### Patch Changes

- Updated dependencies [c50597f]
- Updated dependencies [e09d69a]
- Updated dependencies [a781798]
- Updated dependencies [e09d69a]
- Updated dependencies [e09d69a]
- Updated dependencies [20aed63]
- Updated dependencies [49e1e39]
- Updated dependencies [af2d337]
- Updated dependencies [c50597f]
- Updated dependencies [a6ec9ba]
- Updated dependencies [c50597f]
- Updated dependencies [bfaa06b]
- Updated dependencies [c50597f]
- Updated dependencies [77a6765]
- Updated dependencies [b10d129]
  - @vendoai/core@0.27.0
  - @vendoai/apps@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [c369e14]
- Updated dependencies [443edd4]
  - @vendoai/core@0.26.0
  - @vendoai/apps@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [aa1c8db]
  - @vendoai/core@0.25.0
  - @vendoai/apps@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [42b2b78]
  - @vendoai/apps@0.24.0
  - @vendoai/core@0.24.0

## 0.23.0

### Patch Changes

- @vendoai/core@0.23.0
- @vendoai/apps@0.23.0

## 0.22.0

### Patch Changes

- @vendoai/core@0.22.0
- @vendoai/apps@0.22.0

## 0.21.0

### Patch Changes

- 6856b4f: One venue — the island jail and its apparatus are deleted.

  Model-written code runs in the QuickJS empty room; host-written or human-reviewed code runs native. The double-iframe jail was a third answer, so it goes, and with it its runtime bundle, the ambient island scope, the esm.sh escape hatch, the smoke-render gate and the island syntax gate.

  **Removed from `@vendoai/ui/tree`:** `JailedComponent` and `JailedComponentProps`. The renderer keeps ONE venue: a granted `source: "generated"` node mounts in the host page, an ungranted one drops back to a contained notice. With one venue left, `BoundMode` is gone from `bindValue`/`bindProps`, and the per-island tool manifest and `themeVars` go with the frame that read them.

  **Renamed on `@vendoai/ui/tree`:** `JailFurnishing`, `JailSubSource` and `JailStyle` are `InClientFurnishing`, `InClientSubSource` and `InClientStyle` — minus `packages`, which only ever fed the CDN loader.

  **Removed from `@vendoai/apps/contract`, outright:** `JAIL_PACKAGE_CDN_ORIGIN`, `jailPackageUrl`, `ISLAND_AMBIENT_NAMES`, `ISLAND_AMBIENT_REACT_NAMES`, `ISLAND_AMBIENT_KIT_NAMES`, `ISLAND_AMBIENT_HELPER_NAMES`, `IslandAmbientName`, `ISLAND_STRIPPED_SPECIFIERS`, `ISLAND_RESOLVABLE_SPECIFIERS`, `IslandResolvableModule`, `isStrippedIslandSpecifier`, `IslandImportStrip`, `stripIslandImports`, `blankNonCode`, `islandVendoActionNames`, `islandNetworkViolations` and `islandToolFallbackManifest`.

  **Renamed on `@vendoai/apps/contract`:** `JAIL_ALLOWED_MODULES` is `IN_CLIENT_ALLOWED_MODULES`, `JailModule` is `InClientModule`, `JAIL_BUNDLED_PACKAGES` is `IN_CLIENT_BUNDLED_PACKAGES`, `JailBundledPackage` is `InClientBundledPackage`, and `isPinnedJailPackage` is `isPinnedPackage`. `isIslandResolvableSpecifier`, `scanIslandTools`, `IslandToolScan` and `resolveIslandToolName` stay: `contract/island-ambient.ts` became `contract/screen-tools-scan.ts`, trimmed to the `tools` literal-access scan the tsx door runs and the resolvable-specifier set sync capture asks about. `contract/jail-modules.ts` became `contract/inclient-modules.ts`.

  Two files behind the gate go with it — `server/checking/islands.ts` and `server/checking/smoke-render.ts` — and so do the relocations you should not notice: `jail/viewport-css.ts` to `tree/viewport-css.ts`, `jail/zod-shim.ts` to `tree/inclient-zod-shim.ts` (`JailZodShimError` is `ZodShimError`; both are internal).

  **One fix rides along.** The jail applied `themeVars` from React context, so a generated screen was themed by where its PROVIDER was, not by where its DOM was. With the jail gone, theming rides DOM ancestry — and a bare `<AppFrame>` mounted outside chrome resolved every `--vendo-*` to the empty string and fell back to the porcelain defaults. The surface root is already a boundary, so it declares the theme too, through the same `themeCssVariables()` mapping chrome, the overlay, the approval sheet and the toasts use. Nested in chrome it restates identical values, so there is one mapping and nothing that can disagree.

  `@vendoai/actions` only follows the rename in its closure capture — `CapturedClosure` and `previewBlockingSpecifiers` are unchanged. `@vendoai/mcp` ships its regenerated shim artifact, 4.09 MB down to 3.05 MB.

- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [46aee4a]
- Updated dependencies [83aec51]
- Updated dependencies [01e225c]
- Updated dependencies [d9b7c8d]
- Updated dependencies [5932631]
- Updated dependencies [491a2fa]
- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [37ed821]
- Updated dependencies [6856b4f]
- Updated dependencies [730ac8f]
  - @vendoai/apps@0.21.0
  - @vendoai/core@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [095f143]
- Updated dependencies [7fcf60b]
- Updated dependencies [cfd4f48]
  - @vendoai/core@0.20.0
  - @vendoai/apps@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [2879e46]
- Updated dependencies [39a1c78]
- Updated dependencies [5f4d694]
  - @vendoai/core@0.19.0
  - @vendoai/apps@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [88ec7e6]
  - @vendoai/core@0.18.0
  - @vendoai/apps@0.18.0

## 0.17.0

### Patch Changes

- 8ded5cc: The automation ask stops falling into the two-step trap. The `schedule` verb's words matched its behavior nowhere: titled "Set when this runs" and described as "Set or change … what you are arming", it taught calling agents to build a view with `vendo_make` and then arm it here — but the verb only re-times an EXISTING automation, so the ask died with a refusal and no automation was ever authored (field: every scheduled-task ask on the linkwarden baseline). Now the verb says the one thing it does — retitled "Change when this runs", described as never creating, naming `vendo_make` (this app in `app`, schedule and action in one request) as the authoring door — and the no-trigger refusal carries the same exact next move so a mid-turn agent can recover. The screen agent's escalate door also names away work explicitly ("any part that must run while nobody is watching — a schedule, a product event — … escalate the WHOLE ask"), closing the gap where its skill taught the `<Server>` declaration but the door's own text listed only real-code reasons to leave, so a schedule ask got assembled as a plain view with no trigger. The MCP app shim is regenerated for the retitle.
- Updated dependencies [c17d492]
- Updated dependencies [64004b6]
- Updated dependencies [85fc732]
- Updated dependencies [729dd3e]
- Updated dependencies [9ea21ef]
- Updated dependencies [c79866f]
- Updated dependencies [8ded5cc]
  - @vendoai/core@0.17.0
  - @vendoai/apps@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [d529cf8]
- Updated dependencies [795f8c1]
  - @vendoai/apps@0.16.0
  - @vendoai/core@0.16.0

## 0.15.0

### Patch Changes

- 1529978: the door's OAuth drawers ride the `engine` family

  Registered clients, consent interactions, authorization codes, access and
  refresh grants and their family anchors all reached the store through the
  generic `records.*` door a host uses for its own rows. All 18 sites now go
  through `ops.engine.*` — the same two collections, the same verbs, the same
  arguments, the same order, with `assertEngineCollection` in front of every one
  of them. `store.records(...)` is gone from `packages/mcp/src` entirely.

  `createMcpDoor` takes an optional `ops: StoreOps` beside `store`, threaded from
  the composition. Unset — a `StoreAdapter` with neither its own ops nor a SQL
  handle, which is every BYO adapter — `engineOverAdapter` serves the same seven
  verbs off the adapter's own record doors, gate included, so an unset slot is a
  route and not a downgrade.

  Two consequences of the capability check moving off the call sites. `claim` is
  optional on a record handle and absent on a store that cannot compare-and-claim,
  so each site used to pre-check the handle; on the engine family the verb is
  always there and refuses with `not-implemented` instead. Every OAuth refusal a
  client could already see is unchanged, including all four `server_error`
  bodies — but on such a store a refresh rotation now discovers it after writing
  its candidate grants rather than before, leaving two rows nothing can ever reach
  (their secrets were never returned) on a store where no rotation could have
  succeeded either way; and a revoke that matches no token answers RFC 7009
  success instead of that `server_error`.

  `vendo_threads` stays on the record façade deliberately, as the umbrella's
  threads do: its routed door carries cross-subject refusal, revision CAS and a
  transcript projection the generic engine path does not reproduce.

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

- a7a0fcf: A host's own backend gets in at the MCP door with a service key — no per-user
  OAuth, no browser.

  `createVendo({ mcp: { serviceAuth: { keys: [...] } } })` arms the door's own
  `/token` endpoint for RFC 8693 token exchange: the backend POSTs
  `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` with
  `client_id=vendo-service`, the key as `client_secret`, and one of its own user
  ids as `subject_token`, and gets back a ten-minute `vmat_` bearer token for
  that user. Keys are opaque strings the host mints itself (`openssl rand -hex
32`); the door stores only their hashes, compares in constant time, and
  answers every failure with the same `invalid_client`. No refresh tokens —
  rotation is "exchange again." Audit rows carry a `svc:<hash>` client id so
  service-minted sessions are distinguishable from interactive ones.

- 464dce8: Broker mode is DECLARED, not discovered. Set `VENDO_MCP_BROKER_URL` to your tenant's
  MCP endpoint (`https://acme.mcp.vendo.run/mcp`) and the door trusts that broker:
  the URL's origin is the issuer, the URL itself is the expected token audience,
  and `VENDO_MCP_FEDERATION_SECRET` answers its login handshake. An explicit
  `mcp.remoteAs` still wins.

  This replaces the boot-time ensure-tenant call a `VENDO_API_KEY` plus a public
  `VENDO_BASE_URL` used to make: the app no longer writes its own address to Vendo
  Cloud, so whichever process booted last can no longer decide where the broker
  forwards, and a failed call can no longer silently swap a deployment to a
  different authentication architecture for the life of the process. A
  `VENDO_API_KEY` now has no effect on MCP at all, and a malformed `VENDO_MCP_BROKER_URL`
  fails the composition loudly instead of quietly reverting to a local door.

- ca3a9dc: Four fixes on the MCP door: expired turn credentials, RS256 tokens, blank
  `remoteAs` bindings, and MCP Apps on the turn-credential leg.

  **An expired turn credential no longer comes back to life.** `publish()` refreshed
  the idle expiry of every credential minted for the thread without checking whether
  it had already lapsed, and expiry was only ever evaluated lazily inside `resolve()`.
  A token whose conversation went quiet past the idle budget was therefore dead only
  if someone happened to resolve it; if the conversation took another turn first, the
  expiry was pushed forward and the token worked again. Lapsed entries are now dropped
  in that same loop, across the whole registry rather than only the thread being
  published, which also bounds it in a long-running host process — a token minted for
  a conversation that never takes another turn previously had nothing to remove it.

  **`remoteAs` accepts the algorithms real authorization servers use.** Verification
  was pinned to ES256 alone, so a door pointed at Auth0, Okta, Entra ID or Cognito —
  all of which issue RS256 by default — returned 401 on every request with no local
  `/authorize`, `/token` or `/register` to fall back to. The allowlist is now
  `RS256/384/512`, `PS256/384/512` and `ES256/384/512`; symmetric algorithms and
  `none` stay rejected. Separately, a blank `remoteAs.issuer` or `audience` now fails
  at `createMcpDoor` instead of silently disabling the claim check it names.

  **Opening a saved app over a turn credential renders.** One door composed with both
  `apps` and `turnCredentials` — which is every `createVendo({ mcp: true })` — made
  apps render on the OAuth leg only. The turn leg advertised no shim resource on its
  `vendo_apps_*` listings and returned the registry's raw `OpenSurface` envelope with
  the already-resolved query declarations still in it. Both legs now run the same two
  steps.

  Revoking a client no longer scans every outstanding authorization code in the
  deployment. That scan looked for codes carrying no grant family, which the only
  code-minting path cannot produce.

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

- 10a2b44: `agent()` mounts the tool door its harness has always required.

  `claudeCode()` declares `requires: { toolDoor: true }` on both legs — a box and
  a local subprocess each reach the host's tools over remote MCP — and
  `@vendoai/agents` never filled the slot. A boxed agent therefore booted with the
  model's own hands (Bash, Read, Write) and NONE of the host's tools: no `api()`,
  no `tool({ … })`, no `mcp:` servers. It was silent, because the harness's warning
  is itself gated on a door existing.

  `agent()` gains one optional key, **`door: { baseUrl }`** — the publicly
  reachable origin the thinker dials back to. Unset it falls back to
  `VENDO_BASE_URL`; an explicit value always wins. A `machine: "local"` thinker
  that resolves neither gets a loopback listener this package serves itself — a
  subprocess can always dial 127.0.0.1, so zero-config development loses
  nothing. A SANDBOXED harness that resolves neither is a BOOT error naming both
  ways out, never a turn that dies in front of a user: loopback is not reachable
  from a box.

  A library cannot add a route to the host's server, so the door's fetch handler
  comes back out: mount `agent.door` at the exported `DOOR_PATH`
  (`/api/vendo/mcp`, the same mount `createVendo` uses). It is
  `createMcpDoor({ internal: true })` — no authorization server, no discovery, no
  consent page, and no listing for anyone but a live turn. The door's hostname
  joins the box's egress allowlist, and the runtime's `liveTurn` seam is wired, so
  a credential the harness mints resolves to the turn that minted it and to
  nothing between turns.

  `@vendoai/agents` now depends on `@vendoai/mcp`, which widens a standalone
  install with `@modelcontextprotocol/sdk` and `jose`.

  `createTurnCredentials` — the turn-credential registry — moves from
  `@vendoai/vendo` down into `@vendoai/mcp`, beside the `LiveTurn` /
  `TurnCredentialPort` types it speaks, so the umbrella and the standalone runtime
  share ONE implementation instead of each growing their own. No behaviour change
  for `createVendo`.

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

### Patch Changes

- dcc08ab: The MCP door no longer tells a client a tool is non-destructive when nobody has
  graded it.

  Every listing carried `readOnlyHint` and `destructiveHint` derived from the
  tool's risk label, and `ungraded` fell through to the same pair a `write` gets:
  `readOnlyHint: false`, `destructiveHint: false`. MCP's own default for
  `destructiveHint` is **`true`** — absent means "assume destructive" — so
  emitting `false` was not a neutral value, it was an active claim of safety about
  a tool no human, no judge, and no protocol fact had ever judged. That is exactly
  the guess the risk-grading redesign deleted everywhere else, still being made on
  the wire.

  An `ungraded` tool now asserts neither hint. They are omitted, and the client
  falls back to the spec's own conservative defaults. `destructiveHint: true`
  would have been the opposite guess and just as unfounded; `readOnlyHint: false`
  claims "this modifies its environment", which is equally unknown. The door says
  nothing it cannot support, and `title` still rides along. Grade the tool
  (`vendo sync`, the judge, or `.vendo/overrides.json`) and the hints come back.

  `read`, `write`, and `destructive` listings are byte-for-byte unchanged. Both
  surfaces that build MCP tools — the OAuth listing an outside agent sees and the
  live-turn listing a `claudeCode()` box reads — share the one helper, so they
  cannot drift.

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

- 49e9ccc: Add database-level atomic claims for multi-instance OAuth code redemption and refresh-token rotation.
- 0d2810b: Add RFC 7009 token revocation, grant-family invalidation, per-client host disconnects, and revocation/scope discovery metadata.

### Patch Changes

- 4b8ac66: Per-user connected accounts via the Composio broker (ENG-262). Connectors gain a subject-scoped `connections` capability (list/initiate/status/disconnect); the umbrella serves per-principal `/connections` endpoints with a Vendo Cloud broker seam behind `VENDO_API_KEY`; a Composio call missing a connection returns the new typed `connect-required` tool outcome, rendered by `VendoThread` as an inline connect card that retries after connecting; `ConnectedAccountsPanel` (list + disconnect) joins the chrome as the accounts tab. Composio tools carry curated risk (metadata hints + slug patterns) instead of a blanket `write`; the MCP connector accepts an async per-principal `headers` resolver with per-subject sessions; every connector execution is audited with its account identity.
- Updated dependencies [49e9ccc]
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [fa0ad98]
- Updated dependencies [51f3fc9]
- Updated dependencies [ff6b5d5]
  - @vendoai/core@0.4.0
