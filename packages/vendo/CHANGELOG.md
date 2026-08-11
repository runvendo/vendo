# @vendoai/vendo

## 0.15.0

### Minor Changes

- b57df06: `createVendo` prints one block when it finishes composing, and the palette it
  paints with becomes a core primitive.

  A deployment used to boot in silence. Which store it composed, which sandbox,
  whose model key it picked up and which auth story was actually live were all
  knowable only by reading `/status` or the source — which meant the answer arrived
  after something had already gone wrong. The boot summary says it once, to the
  operator, at the moment it becomes true: one row per seam that is really serving,
  naming the venue it chose and the thing that chose it, an environment variable or
  the config line the host wrote. A seam nobody filled stays quiet, because silence
  is the honest report for a slot a host declined to use.

  The block is a single event through core's log sink, so a host can route or
  quieten it like any other line, and it can never be split across streams or
  arrive interleaved with something else. It is composed facts only — nothing in it
  stats a path, opens a handle or awaits anything, so `createVendo` stays I/O-free
  at module init and keeps working on Workers. The one judgment that genuinely
  needs the filesystem, whether the data directory survives a redeploy, is made by
  the seam that owns it and arrives here as data.

  `vendoStyle()` and `VendoStyle` move into `@vendoai/core`: one palette and one
  `pretty` decision, reachable from packages that sit below `vendo`, instead of
  each caller keeping its own copy of the same four helpers.

  `HostAuthPreset` gains an optional `name`, which is how the auth row can say
  `clerk` instead of just "a preset". It is display only — nothing branches on it,
  a preset a host composed itself has no vendor to name and says so rather than
  borrowing one, and a name that is not an identifier is not rendered at all.

- b324b79: **Breaking.** Third-party provider keys no longer select adapters. Pass the
  adapter explicitly (`vendo init` now writes it for you) or set `VENDO_API_KEY`.

  Env keys are credentials; config selects. A key lying around in the environment
  used to choose which sandbox a deployment ran on, which provider it billed, and
  which account every app machine's inference went to — decided by nothing anyone
  wrote down. `VENDO_API_KEY` is now the only environment variable that fills an
  adapter slot you left unset. Every ladder reads the same way: explicit config,
  then `VENDO_API_KEY`, then an honest failure that names both ways out.

  - **Sandbox.** `E2B_API_KEY` no longer selects the e2b venue. It is the
    credential an explicit `sandbox: e2bSandbox()` reads when you pass no inline
    `apiKey`, and `e2bSandbox()` now refuses at boot — rather than at the first
    box build — when the optional `e2b` package does not resolve from the project.
    An unset `sandbox` slot composes the Cloud sandbox with `VENDO_API_KEY`, or
    nothing. `selectSandbox` drops its e2b rung and its `e2bSpecifier` parameter;
    the `"e2b"` venue string stays in the `/status` union for older wires, but an
    explicit adapter reports `"custom"` like any other.
  - **Agent model.** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
    `GOOGLE_GENERATIVE_AI_API_KEY` select nothing. They are read by the
    `@ai-sdk/*` provider you construct and pass in `models`. With no `models` and
    no `VENDO_API_KEY`, the first turn says exactly that instead of quietly riding
    a key you set for something else.
  - **Box inference.** The `VENDO_INFERENCE_URL` + `VENDO_INFERENCE_KEY` pair wins
    as a pair — both halves or neither — then `VENDO_API_KEY` rides the Cloud
    gateway, then the box gets no inference door. The `ANTHROPIC_API_KEY` rung is
    gone from both `boxInference()` and the Claude Code harness's
    `inferenceEnv()`: a provider key in the deployment's environment used to point
    every box at `api.anthropic.com` and bill that account.
  - **Doctor.** `E-LIVE-007` is retired — with no key-selected venue there is no
    such thing as a venue the operator did not ask for, and the boot refusal is
    earlier and louder than a probe. The code stays in the append-only registry
    and keeps its verify-page anchor. `E-LIVE-004` now names the two ways out.

  `VENDO_DEV_CREDENTIAL` still pins a credential rung, and is now the only way to
  reach an `env-key` rung at all — but it is internal, Vendo's own E2E rung matrix
  and escape hatch, not a host knob, and it can change without notice. Your app's
  model belongs in `models`.

- 545416a: The store warns when it is writing to disk the platform wipes, and `vendo doctor`
  finds the same thing statically as `E-STORE-001`.

  Railway, Render, Fly.io and Heroku all run a long-lived process, so PGlite
  genuinely works there and refusing outright would be wrong — but they replace the
  container filesystem on every redeploy. The store kept working and quietly lost
  every app the host's users had built at the next deploy, with nothing said at any
  point. It now says so at construction, naming the directory it is about to write
  to and both ways out: mount a persistent volume and point `dataDir` at it, or
  pass a Postgres `url`.

  A platform marker is evidence on its own, so the warning does not wait for data
  to appear — warning before the first user writes is the whole point. A path under
  `/tmp` warns without a marker. `memory://` and a configured Postgres `url` say
  nothing, and the existing hard refusal on genuinely serverless environments
  (Vercel, Cloudflare Pages, Lambda) is untouched and still throws, because there
  PGlite cannot work at all.

  `vendo doctor` carries the static twin as `E-STORE-001`, so the wipe is findable
  before a deploy rather than after one. A project under `/tmp` additionally needs
  a real database sitting there: a scratch checkout under `/tmp` is what doctor
  sees on a laptop, and a false warning on every local run is worse than no
  warning. The check also stays quiet when `VENDO_API_KEY` composes the hosted
  store, since the local data directory is then one that nothing ever writes to.

- 8f00291: The selection law leaves a way out: the migration surface for "env keys are
  credentials, config selects".

  `vendo init` writes the `models:` line again. It resolved the key through the
  runtime credential ladder, which by design stopped answering for a bare provider
  key — so the one thing that turns a host's existing key into explicit config
  became unreachable, and the detection now reads the environment directly. The
  `--byo` paste is covered too: that key arrives during the cloud step, after the
  composition was planned and before anything is written, so the run re-renders
  the composition it authored instead of saving a key that selects nothing. The
  closing summary no longer advises setting a model key on a run that just wrote
  one.

  The provider init writes an import for is the provider it installs. `ensureProviderDeps`
  asked the runtime credential which `@ai-sdk/*` package the host needs, and a bare
  provider key is `rung: "none"` — so a fresh host with only `OPENAI_API_KEY` (or a
  Google key) had an `@ai-sdk/openai` import written into its route and nothing
  installed to satisfy it, and the app could not build. It now covers both answers:
  what a runtime turn loads, and what this run actually wrote.

  `vendo sync --ai` stops telling a developer to set the key they already set. Its
  credential gate ran on the runtime resolver alone, so a machine whose only
  credential is `ANTHROPIC_API_KEY` was told "set ANTHROPIC_API_KEY" while the
  harnesses that authenticate with exactly that key were never probed. The gate now
  also reads the provider keys a rung runs on, which is what makes the message
  honest: it can only be reached when every credential it names is genuinely
  absent.

  `claudeCode({ machine: "local" })` fails loudly with no model. That machine
  REPLACES the subprocess environment, so a deployment whose only credential was a
  provider key now hands the session nothing — intended, but it used to die deep
  inside the SDK. It names both ways out, explicit endpoint first: the
  `VENDO_INFERENCE_URL` + `VENDO_INFERENCE_KEY` pair, or `VENDO_API_KEY` for the
  Cloud gateway.

  The `mastra-agent` example composes its models explicitly instead of expecting
  the environment to pick one, and the docs that still described env-resolved
  selection say what the code does.

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
- Updated dependencies [545416a]
- Updated dependencies [ec80477]
- Updated dependencies [1529978]
- Updated dependencies [8f00291]
- Updated dependencies [bb15cda]
  - @vendoai/apps@0.15.0
  - @vendoai/core@0.15.0
  - @vendoai/agents@0.15.0
  - @vendoai/harnesses@0.15.0
  - @vendoai/store@0.15.0
  - @vendoai/knowledge@0.15.0
  - @vendoai/mcp@0.15.0
  - @vendoai/actions@0.15.0
  - @vendoai/automations@0.15.0
  - @vendoai/ui@0.15.0
  - @vendoai/guard@0.15.0

## 0.14.0

### Minor Changes

- 954ad09: **Breaking.** The generic `records.*` store ops are gone. `/records/*` now
  answers `not-implemented` (501), naming the op you called. There is no flag,
  no fallback and no deprecation window left — this release IS the removal.

  **Do this.** Find every `ops.records.*` call and move it to the family that owns
  the data:

  - Rows and files a generated app invents → `ops.appData.put/get/list/delete` and
    `ops.appData.putFile/getFile/listFiles/deleteFile`. The target carries
    `{ appId, collection, owner }`; the owner is stamped on writes and scopes
    reads, so you no longer prefix a collection name to keep users apart.
  - Vendo's own collections (threads, runs, grants, audit, effects, apps,
    automations schedules and deliveries) → `ops.engine.*`. Same seven verbs, same
    arguments, same returns, behind the `ENGINE_COLLECTIONS` allowlist. A name
    outside it is refused with `blocked` and told where its data belongs.

  **If you wrote raw HTTP against the store wire,** the seven `/records/*` routes
  are the break: `POST /records/put` now returns

  ```json
  {
    "error": {
      "code": "not-implemented",
      "message": "the store wire no longer serves records.put — …"
    }
  }
  ```

  with HTTP 501. `STORE_WIRE_PATHS` holds 35 ops across 8 families, and
  `status()` reports `ops: 35`.

  **The `StoreAdapter` façade is unchanged and still supported.**
  `store.records(collection)` and `store.blobs(namespace)` keep working exactly as
  they did — including `claim` and `atomic` feature detection. On `hostedStore`
  they are now built on the two surviving families: an `app:<appId>:<name>`
  collection or namespace rides `appData`, everything else rides `engine`. Two
  consequences on the hosted adapter only:

  - A collection outside the engine allowlist (a host's own `"invoices"`) no
    longer has a home on the hosted mount and is refused with `blocked`. Local
    and BYO stores are untouched.
  - An app-scoped drawer is owner-scoped now, like every other appData read.
    `hostedStore({ owner })` names the owner; it defaults to the single-player
    `"user_local"`, matching `createStoreOps`' bound workspace owner. **If you
    serve more than one end user through one `hostedStore` instance, set it** —
    on the default, every user's app rows and files land in one owner's drawer
    and read each other. Construct one `hostedStore` per end user, or use
    `ops.appData`, whose every verb names its owner at the call. Because
    `appData` has no compare-and-set verbs, an app-scoped `RecordStore` omits
    `claim` and `atomic` rather than advertising what it cannot serve.
  - One error string changed: a bare, envelope-less 404 from a blob read on the
    hosted adapter now says `Vendo Cloud store request failed with 404` instead
    of naming a "bare 404". Same behaviour — it still throws loudly rather than
    reading as a missing blob — but stop grepping for the old wording.

  **Also removed, because they only existed to announce the retirement:**
  `STORE_WIRE_DEPRECATED_OPS`, `STORE_WIRE_DEPRECATED_REMOVED_IN` and
  `STORE_WIRE_MIN_CLIENT_VERSION` (all `@vendoai/core`), the `deprecated` and
  `minClientVersion` fields on `StoreWireStatus`, the seven deprecated
  `storeWireRecords*RequestSchema` aliases (use `storeWireCollection*RequestSchema`),
  and doctor's `E-LIVE-008` warning. The `E-LIVE-008` code stays listed in the
  registry and on the verify page — doctor codes are never reused — but nothing
  emits it any more. The handshake body still passes unknown keys through, so a
  client on this release reads an older mount's `/status` without complaint.

### Patch Changes

- 4346712: The umbrella's own drawers go through the `engine` family instead of the generic
  record façade.

  Generic `records.*` is a host's door onto its own data. Vendo was reaching for
  its own collections through it — the parked BYO approvals, the app and grant
  drawers the impact report reads, the app row machine provisioning resolves an
  owner from, and the two `vendo sync` pushes to Cloud. Nothing in that call said
  which collections were Vendo's, so nothing could refuse a call that reached for
  one. Each of these now names its collection through `ops.engine.*`, which is the
  same seven verbs onto the same routed doors with `assertEngineCollection` in
  front — per-collection policy is unchanged, because `engine` reaches the very
  same door `records` did.

  The one behavior change is a refusal that used to be silence. A deployment whose
  store offers neither its own `ops` nor a SQL handle previously ran these paths
  through the façade; it now gets a `not-implemented` naming the two stores that
  serve them (`store: postgres(url)` or the Cloud hosted store). Three seams do
  this — parking a BYO guarded call, the `/sync/impact` report, and machine-app
  provisioning. The fourth, the `?pending=1` app probe, keeps its existing
  behavior of degrading to the pending window rather than throwing, because that
  is what it already did for any store that could not answer.

  `vendo_threads` stays on the record façade deliberately, as `mcp` and
  `knowledge` do: its double mirrors the routed door's projection and
  cross-subject refusal, and reaching it through a second door would have traded
  real coverage for a rename.

- Updated dependencies [954ad09]
  - @vendoai/core@0.14.0
  - @vendoai/store@0.14.0
  - @vendoai/actions@0.14.0
  - @vendoai/agents@0.14.0
  - @vendoai/apps@0.14.0
  - @vendoai/automations@0.14.0
  - @vendoai/guard@0.14.0
  - @vendoai/harnesses@0.14.0
  - @vendoai/knowledge@0.14.0
  - @vendoai/mcp@0.14.0
  - @vendoai/ui@0.14.0

## 0.13.0

### Minor Changes

- 031195f: The generic `records.*` store ops are deprecated. They still work; they will be
  removed in `0.13.0`.

  **What is happening.** `records.*` was one untyped door onto every row in the
  store — a host's data, an app's data and Vendo's own bookkeeping all went through
  the same seven verbs, and nothing in the call said which was which. Two named
  families replaced it: `appData.*` for the rows and files a generated app invents
  (the owner is stamped for you, so one user's data cannot be read by another's app
  session), and `engine.*` for Vendo's own collections (the same seven verbs, behind
  the `ENGINE_COLLECTIONS` allowlist). Everything `records.*` can do, one of those
  two can do with the ownership question answered.

  **Nothing breaks in this release.** All seven `records.*` ops stay on the wire and
  keep their exact behaviour. This release only _announces_ the retirement, in the
  two places a caller will actually see it:

  - `status()` (`GET /status`) now returns `minClientVersion` and `deprecated` — the
    seven `records.*` op names — beside the existing `format` and `ops: 42`. Clients
    that already parse the handshake get the notice for free; the fields are
    optional on `StoreWireStatus`, so an older client ignores them.
  - `vendo doctor` warns `E-LIVE-008` when a mount advertises deprecated ops, naming
    them and the removal release. It is a warning, never a failure — doctor still
    exits 0.

  **What you need to do before `0.13.0`.** Find your `records.*` calls and move each
  one to the family that owns the data:

  - Rows and files belonging to a generated app → `appData.put/get/list/delete` and
    `appData.putFile/getFile/listFiles/deleteFile`. The target carries `appId`,
    `collection` and `owner`; you no longer invent a collection-name prefix to keep
    users apart.
  - Vendo's own collections (threads, runs, grants, the audit log, effects, apps,
    automations schedules and deliveries) → `engine.*`, same arguments, same
    returns. A name outside the allowlist is refused with `blocked` and told where
    its data belongs.

  If you host your own store mount, `STORE_WIRE_DEPRECATED_OPS` and
  `STORE_WIRE_DEPRECATED_REMOVED_IN` (both `@vendoai/core`) are what the handshake
  advertises, so your mount can say the same thing without hardcoding the list.
  `STORE_WIRE_MIN_CLIENT_VERSION` names the release the mount was built from.

  After `0.13.0`, a `records.*` call answers `not-implemented` (501). There is no
  flag to keep the old door open.

### Patch Changes

- 395fc1e: automations reaches its own drawers through the `engine` op family

  Every collection this engine owns — `vendo_apps`, `vendo_runs`, `vendo_grants`,
  `vendo_approvals`, the captures, the arm rows, the schedule cursors, the webhook
  secrets, the delivery ledger, and both sponsorship drawers — was reached through
  the generic `store.records(...)` door a host uses for its own data. All 41 call
  sites now go through `ops.engine.*`, so the allowlist gate in
  `assertEngineCollection` applies to every one of them.

  `AutomationsConfig` gains an optional `ops: StoreOps` beside `store`, threaded
  from composition. It stays optional because `selectStoreOps` answers `undefined`
  for a store with neither its own ops surface nor a SQL handle, and because a
  host may construct the block directly with nothing but a `StoreAdapter`.

  `engineOverAdapter` (new, in core) is that store's engine family: the allowlist
  gate in front, the adapter's own record door behind. It lives in core because
  automations, guard and apps all need it and none of them may import
  `@vendoai/store`. Where `RecordStore.atomic` is absent it keeps exactly the
  degradation those blocks used to hand-roll — `insertIfAbsent` becomes a
  check-then-put, `compareAndSwap` a last write — so moving onto the family does
  not turn a working BYO adapter into a `not-implemented`.

  No behavior change: same collection, same verb, same arguments, same order.

- 62d84ca: `vendo init`'s banner arrival now composites over the detection scan: the wave keeps playing above while the tagline, the header and a checkmarked scan of your app build below it, so the facts land as `✓` lines instead of after a flash.

  The MCP path's closing steps gain real formatting — numbered headlines with their detail indented under them, and the two broker environment values as their own group.

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
- Updated dependencies [9034bcc]
- Updated dependencies [031195f]
  - @vendoai/automations@0.13.0
  - @vendoai/core@0.13.0
  - @vendoai/guard@0.13.0
  - @vendoai/store@0.13.0
  - @vendoai/actions@0.13.0
  - @vendoai/agents@0.13.0
  - @vendoai/apps@0.13.0
  - @vendoai/harnesses@0.13.0
  - @vendoai/knowledge@0.13.0
  - @vendoai/mcp@0.13.0
  - @vendoai/ui@0.13.0

## 0.12.0

### Minor Changes

- abe327f: `vendo init` and `vendo sync` redesigned — branded animated banner, five-question guided flow, labelled result blocks (Wired/Catalog/Judgment/Your brand/Impact), spinners on slow phases, timed footer; init scaffolds the MCP door end-to-end (`--use-case mcp`) and doctor gains `E-MCP-009` + `E-WIRE-011`; piped/CI/`--json`/`--agent` output stays byte-identical.

### Patch Changes

- Updated dependencies [0d67885]
  - @vendoai/apps@0.12.0
  - @vendoai/store@0.12.0
  - @vendoai/actions@0.12.0
  - @vendoai/agents@0.12.0
  - @vendoai/automations@0.12.0
  - @vendoai/mcp@0.12.0
  - @vendoai/ui@0.12.0
  - @vendoai/core@0.12.0
  - @vendoai/guard@0.12.0
  - @vendoai/harnesses@0.12.0
  - @vendoai/knowledge@0.12.0

## 0.11.0

### Minor Changes

- eeebbee: The agent's data tools move onto `appData` — one user can no longer see another's rows.

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

- a216b68: Box rows are owner-stamped, and the box still never learns who the user is.

  `PUT $VENDO_STORE_URL/rows/<collection>/<id>` used to land in the generic
  records family, where every row an app wrote was one drawer per app and nothing
  more. It now lands in the `appData` family, so the door stamps each row with the
  subject of the app token that presented it: one user's rows are the only rows
  that user's requests can read, list, overwrite or delete. Cross-user access is
  unwritable rather than merely forbidden — an id another user holds comes back
  `409 conflict`, and a caller who tries to name an owner by sending
  `refs.subject` is refused `400 validation`.

  Nothing about this crosses the sandbox boundary. The box is told no identity and
  takes no owner parameter; the door stamps on its behalf, which is why the client
  below has no owner argument to get wrong.

  The HTTP contract is unchanged, byte for byte. Existing rows keep their
  collection names (`app:<id>:box:<collection>`), and the `appData` backfill gives
  rows written before the flip their owner stamp.

  **`./rows.js` in the box template** — a zero-dependency client for the door,
  which the in-box coding agent is now pointed at first and the raw curl second:

  ```js
  import { rows } from "./rows.js";

  const notes = rows("notes");
  await notes.put("note_1", { title: "Hello" }); // → the stored record
  await notes.get("note_1"); // → the record, or null
  await notes.list({ limit: 20 }); // → { records, cursor? }
  await notes.delete("note_1");
  ```

  It is the app's server half only — it reads `$VENDO_APP_TOKEN`, and `fns.js` is
  the only place that may. A failure throws an `Error` carrying `.code` and
  `.status`, so a caller branches on `error.code === "conflict"` instead of
  parsing prose.

  A deployment whose store offers neither a SQL handle nor a `StoreOps` surface
  now refuses THAT REQUEST on the rows door, naming both ways to give it one,
  rather than writing rows nobody owns.

- e58520e: `appData` — the store family for everything generated apps invent.

  The `StoreOps` contract grows from 27 ops across 7 families to 35 across 8. The
  new family is `appData`, and it exists because generic `records.*` made every
  app's data one flat namespace with no answer to "whose row is this".

  **Every appData row is owner-stamped, by the runtime.** `appData.put` writes
  `refs.subject = <caller>` from the host's login session. Generated code has no
  field for the owner and cannot invent one: a caller that supplies `refs.subject`
  itself is refused with `validation`, never silently overwritten. Unstamped rows
  cannot exist.

  **Reads are auto-scoped, so permission IS the query.** `list` ANDs the stamp
  into `query.refs`, `get` returns `null` for another owner's row, and `delete`
  no-ops on one — one owner-predicated statement, so there is no window in which a
  foreign row can be raced out from under a check. A `put` against an id another
  owner holds is refused with `conflict` rather than overwriting and re-stamping
  it. Caller refs still filter alongside the stamp. There is no rules language and
  no policy DSL to get wrong.

  The stamp is `refs.subject`, deliberately not a new column: the erase cascade
  already deletes stamped rows and the GIN index on `refs` already serves scoped
  reads, so this ships with **no schema change**. `@vendoai/store` gains one
  composer, `app-data-rows.ts`, as the single place that spells
  `app:<appId>:<collection>` and the `<owner>/` file-key prefix.

  **File twins take a required owner.** `putFile`/`getFile`/`listFiles`/
  `deleteFile` live in the app's existing blob namespace under an `<owner>/` key
  prefix, which `listFiles` strips on the way out. One new erase selector sweeps
  those keys on the subject axis, so a member's files inside a _promoted_ org app
  — an app the org owns, which the subject cascade never reached — now die with
  the member.

  All eight verbs speak `vendo/store-wire@1` at `/app-data/*` with exported
  request schemas, and are implemented by the local Postgres backend, the Cloud
  client, and the in-core memory reference. Eleven conformance cases pin the
  behavior in one place and every backend runs them. `StoreWireStatus` also gains
  an optional `deprecated` list so a mount can announce ops it is retiring.

  `StoreAdapter` — the BYO seam — is untouched.

- 863dc53: `engine` — the store family for Vendo's own drawers, behind an allowlist.

  The `StoreOps` contract grows from 35 ops across 8 families to 42 across 9. The
  new family is `engine`, and it is today's `records.*` family verb for verb —
  `get`, `put`, `delete`, `list`, `claim`, `insertIfAbsent`, `compareAndSwap`, same
  arguments, same returns, same routed doors — with one thing added in front of
  every verb: `assertEngineCollection(collection)`.

  **The point is the name and the gate, not new semantics.** Grants, approvals, the
  audit log, threads, runs, apps, effects, the automations schedules and deliveries,
  the guard's freeze switch — Vendo's own bookkeeping — all reached the store
  through the same generic `records.*` door a host uses for its own data. Nothing
  said which collections were Vendo's, so nothing could refuse a call that reached
  for one. `engine` says it, and refuses everything else with `blocked`.

  `ENGINE_COLLECTIONS` (`@vendoai/core`) is that list: 35 static names — the nine
  reserved collections, the four dedicated tables, and the 22 the blocks own on the
  generic table — plus exactly one dynamic pattern, `vendo:app-history:<id>`, built
  by `engineAppHistory(appId)`. It lives in core rather than `@vendoai/store`
  because `guard`, `automations` and `apps` all need to name their own collections
  and none of them may import the store; `@vendoai/store` is what _enforces_ it. A
  refused name is told the allowlist version, the nearest allowed name when it
  looks like a typo, and where its data actually belongs — app data belongs to
  `appData`.

  **Per-collection policy did not move.** `engine` reaches the same
  `createReservedRecordStore` doors, so the audit log is still append-only through
  it, the effect ledger is still insert-once, and a collection with no atomic
  support still answers `not-implemented`. Two conformance cases pin exactly that,
  because a second door onto the same rows is the natural place for policy to
  quietly stop applying.

  Seven wire paths under `/engine/*` join `vendo/store-wire@1`, served by the local
  Postgres backend, the Cloud client and the in-core memory reference, with seven
  conformance cases run by all three. The seven collection-addressed request
  schemas are renamed `storeWireCollection*RequestSchema` — one body shape now
  serves both `/records/*` and `/engine/*` — and the old `storeWireRecords*` names
  stay exported as deprecated aliases.

  `records.*`, `StoreAdapter` and every existing call site are untouched.

### Patch Changes

- fc902aa: `vendo doctor`'s mount-agreement check (E-CFG-003) now fires when the OpenAPI
  spec declares a relative `servers[0].url` and `VENDO_BASE_URL` is unset.

  It used to return early in exactly that case, so the check was silent in the one
  posture that breaks. With no base URL the wire learns the bare request ORIGIN
  (`onRequestOrigin`) and stored binding paths are prefix-free by law (spec
  2026-08-06 §B1), so a path-mounted host serves every host tool one prefix short
  of the real endpoint: every page renders and every tool call 404s. The existing
  disagree/agree branches and the error code are unchanged.

- Updated dependencies [5c8043d]
- Updated dependencies [5c8043d]
- Updated dependencies [eeebbee]
- Updated dependencies [402e7ad]
- Updated dependencies [a216b68]
- Updated dependencies [aeb1bae]
- Updated dependencies [e58520e]
- Updated dependencies [863dc53]
  - @vendoai/core@0.11.0
  - @vendoai/store@0.11.0
  - @vendoai/apps@0.11.0
  - @vendoai/actions@0.11.0
  - @vendoai/agents@0.11.0
  - @vendoai/automations@0.11.0
  - @vendoai/guard@0.11.0
  - @vendoai/harnesses@0.11.0
  - @vendoai/knowledge@0.11.0
  - @vendoai/mcp@0.11.0
  - @vendoai/ui@0.11.0

## 0.10.0

### Minor Changes

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

- 79d7088: The per-person app-sharing chain — the Share dialog and everything under it —
  is removed. No host ever mounted the dialog; every name below was re-grepped
  across `packages/`, `examples/`, `fixtures/`, `corpus/`, `scripts/`,
  `docs-site/` and the console repo before removal, and the only callers found
  were other members of this same chain.

  **Gone from `@vendoai/ui`:** the `ShareDialog` component and `ShareDialogProps`
  (from `@vendoai/ui/chrome`), the `useAppGrants` hook, and the five client
  methods that existed only to feed them — `client.apps.grants`, `.share`,
  `.unshare`, `.promote` and `.resolvePerson`. `ForkOffer` and
  `encodeGrantPrincipal` shared the dialog's file and are unaffected; the file is
  now `chrome/fork-offer.tsx`.

  **Gone from `@vendoai/vendo`:** the wire routes `GET`/`POST`/`DELETE
/apps/:id/grants`, `POST /apps/:id/grants/resolve` and `POST /apps/:id/promote`,
  their handlers, and the `promoteApp` composition seam.

  **Gone from `@vendoai/apps`:** `AppsRuntime.promote`, and the write half of
  `AppsRuntime.access` — `list`, `grant`, `revoke` and `holder`. Their now
  unreachable supporting seams go with them: `AppsConfig.multiParty`,
  `AppsConfig.promoteApp`, and the internal `requireMultiParty` / `requireAccess`
  / `reportShare` helpers.

  **Unchanged, and deliberately so:**

  - `AppsRuntime.access.levelFor`, and `access-checks.ts`' `holds` / `owned` /
    `requireOwned` / `grantedRecords` — the permission backbone behind every app
    door.
  - The `AppAccess` seam itself (`@vendoai/store`'s `appAccess(store)`), whose
    full `levelFor`/`grant`/`revoke`/`list`/`can` surface and conformance kit are
    untouched. Grant rows are still written and read there; only the runtime door
    over that write half is gone.
  - `vendo.apps.share()` and `vendo.apps.publish()` — the Cloud snapshot and
    registry feature. A different feature that merely shares a name with the
    deleted grants `share`.
  - The auth presets' `resolvePerson` seam and `/status`'s `namesPeople` flag.
  - `@vendoai/store`'s `appStore().promote` row primitive and the hosted store's
    `lifecycle.promote` op.

- 89b4444: The `resolvePerson` auth-preset hook and the `namesPeople` status field are
  removed. Both existed for one reason — telling the Share dialog whether it could
  offer to share an app with one named person — and that dialog, with the whole
  grants chain under it, was removed in #1108. Nothing has read either since. Every
  name was re-grepped across `packages/`, `examples/`, `fixtures/`, `corpus/`,
  `docs-site/` and `scripts/` before removal.

  > **BREAKING for hosts that wired `resolvePerson`:** the hook is gone from all
  > seven auth presets (`identity`, `authJs`, `auth0`, `clerk`, `jwt`, `supabase`,
  > and the shared options type). Delete the `resolvePerson:` property from your
  > `auth:` config — it is now a type error, not a silent no-op. Nothing else about
  > your preset changes, and no behaviour you can observe changes with it: the
  > callback has had no caller since #1108.

  > **BREAKING for surfaces reading `GET /status`:** the response no longer carries
  > `namesPeople`, and `VendoStatus.namesPeople` / `useVendoStatus().namesPeople`
  > are gone from `@vendoai/ui`. The field only ever reported whether the seam
  > above was wired.

  `ResolvedPerson` is gone from `@vendoai/core` — it was the hook's return shape
  and had no other producer or consumer.

  **Untouched, and deliberately:** `auth.memberships` and `auth.facts` (the other
  preset seams), `/status`'s `memberships` field, the `Membership` type, and every
  part of `can()` / `AppAccess`. Vendo still holds no directory; the difference is
  that it no longer ships a seam nobody asks a question through.

- 70644e3: One briefing pack, assembled once, handed to both generation rungs

  What a writer is told about the host's product is now a single object,
  `BriefingPack` (`@vendoai/apps/contract`), rendered once by
  `renderBriefingPack` and read by both rungs: the screen agent and the in-box
  builder. It carries the theme verbatim, the host's design rules,
  `.vendo/brief.md`, the component catalog one line per entry, and the
  semantics-annotated tool shape card.

  This closes two silent gaps. `.vendo/brief.md` never reached the screen agent
  at all, and the in-box builder was told nothing about the brand, the rules, the
  catalog or the tool shapes. Instructions stay per-rung — the screen agent's
  dialect manual and the box's skin contract are different jobs.

  Breaking:

  - `@vendoai/apps` no longer exports `hostDesignBrief`. Compose a `BriefingPack`
    and call `renderBriefingPack` instead.
  - `AppsConfig.designRules` is replaced by `AppsConfig.briefing`. `AppsConfig.theme`
    survives for the served-app `?vendoTheme=` handoff only.
  - `GenerationDependencies` no longer carries `theme` / `designRules`, and
    `snapshotDesignRules` is removed with them.
  - `ScreenAssemblerDeps`' `design` and `system` slots collapse into one
    `briefing` slot, and `ScreenInput` takes a rendered `briefing` string.

  One removal a host can feel: the CONVERSATIONAL harness prompt no longer carries
  the design brief. `createVendo()`'s composed `turn.system` used to end with the
  `THEME TOKENS:` JSON and the `HOST DESIGN RULES:` block appended after the
  system prompt; that suffix is gone. What still reaches that prompt is the
  product brief and, through `catalogThemeSummary`, the host component lines plus
  a one-line theme sentence (density, motion, typography) — but NOT the theme
  token JSON and NOT `apps.designRules`. This follows from `claudeCode()` being
  the harness that RUNS a box rather than the thing that decides what an app is:
  the two writers that build apps — the screen agent and the in-box builder — both
  read the briefing pack, so the house rules reach every writer through one
  rendering instead of three. If your deployment relies on a `claudeCode()` turn
  obeying `apps.designRules` while editing `app.vendo` with its own hands, that
  turn is no longer told them; put those rules in `instructions` (`.vendo/brief.md`),
  which still rides that prompt.

  Otherwise host-facing configuration is unchanged:
  `createVendo({ theme, apps: { designRules } })` and
  `.vendo/{theme.json,design-rules.md,brief.md,catalog.json}` all still work, and
  now reach both generation rungs.

- 384eb09: The "Add to…" picker's destinations come from a per-user slot registry on the
  server instead of `localStorage`. A slot id is host markup, so nothing knows a
  slot exists until a page renders one — but the surface that offers it as a
  destination is usually a different page, and often a different device, which
  `localStorage` could never reach.

  A mounted `VendoSlot` now reports itself through `POST /slots` (batched: a whole
  page of slots is one request, and a client repeats a slot at most once a day, so
  one long-lived tab renews its slots instead of watching them age out), and
  `GET /slots` answers the
  caller's own slots, most recently seen first. Rows age out
  30 days after the last render that reported them, so a slot deleted from the
  codebase stops being offered on its own. The rows live in the generic records
  collection (`vendo_slots`), so there is no migration to run, and `refs.subject`
  puts them in the existing erase cascade.

  > **BREAKING:** `knownSlots`, `noteSlot` and the `SlotNote` type are removed
  > from the `@vendoai/ui` and `@vendoai/vendo/react` roots, and `useKnownSlots`
  > is removed from `@vendoai/ui/chrome`. Read the registry with the new
  > `useSlots()` hook (or `client.slots.list()`); a mounted `VendoSlot` still does
  > the reporting for you, so nothing needs to call the write path by hand.

- b642c4d: The playground and the hosted try surface are gone, and with them two entry
  points: **`@vendoai/vendo/try` and `@vendoai/vendo/try-surface` no longer
  exist**. The exports map goes from thirteen subpaths to eleven.

  `./try` published the hosted try venue's session-composition surface
  (`createSyntheticFetch`, `usecasesFileSchema`, `fixturesFileSchema`,
  `tryProfileSchema`, `assembleTryProfile`, `VENDO_USECASES_FORMAT`,
  `VENDO_FIXTURES_FORMAT`). `./try-surface` published the scripted playground
  shell that `vendo.run/playground` and the docs inline-embed IIFE
  (`vendo.run/playground/embed.js`) both mounted — `mount`, `PlaygroundApp`,
  `TryBootConfig`, `TryProfile`. Both venues are retired: **nothing is served at
  `vendo.run/playground` any more**, and the docs embeds it fed are now static
  images. There is no replacement — run `vendo init` in your own app instead.

  Deleted with them: the seeds extraction pass (`runSeedsPass`), the synthetic
  fetch, the try profile schemas, and the embed-bundle build script. The
  `vendo playground` command already printed a retirement notice and still does.

  `createVendo`'s `profileDir`, `fetch`, and `profile` options are **unchanged** —
  they are general composition seams and only their docs mentioned the dead
  `vendo try` command.

- 079d7d8: `GET /apps/:id/pin-drift` and the `client.apps.pinDrift()` method that called it
  are removed. Neither had a caller: the drift report the drift banner actually
  renders is the `pinDrift` array `open()` attaches to the payload, which is
  unchanged, as are `POST /apps/:id/rebase-pin` and the fork-pin routes.

  No rendered UI changes — the removed client method was never invoked.

- ed44a58: A dev-only workbench diagnostics channel behind `VENDO_WORKBENCH`, and the feed
  store that reads it.

  `@vendoai/harnesses` reports what a turn is doing about itself — step starts and
  ends, guarded tool calls, context and compaction, loadout, hires, errors — on a
  transient `data-vendo-debug` part. The gate is `VENDO_WORKBENCH=1` on the
  server, read once per turn: unset, no channel is registered, so nothing can
  reach the wire and nothing is ever persisted.

  `@vendoai/ui` gains the receiving half: `publishWorkbenchPart` files a chunk,
  `useWorkbenchFeed` reads the turns back in the producer's own `seq` order, and
  `developmentMode` decides whether such a surface renders at all.
  `@vendoai/vendo/react` re-exports all three, so a host on the umbrella package
  can build the pane without reaching for `@vendoai/ui` directly.

### Patch Changes

- f9aa721: `vendo init` and `vendo doctor` find a nested root layout instead of naming a
  file that does not exist

  An app-router host whose routes all live under an i18n segment or a route group
  (`app/[locale]/layout.tsx`, `app/(shop)/layout.tsx`) has no `app/layout.tsx` —
  that nested file IS its root layout. Both commands probed for the literal
  `app/layout.tsx` and, finding nothing, named it anyway: init printed a paste for
  a phantom file, and doctor's E-WIRE-004 demanded the same one. A user who
  followed that instruction created a SECOND root layout, which is the one edit
  that breaks such a host.

  Both now resolve the client root to the shallowest `layout.{tsx,jsx,js}` under
  the app directory (lexicographic on a tie), so the paste and the doctor fix name
  the file the host actually has. Hosts with a real `app/layout.tsx`, pages-only
  hosts (`pages/_app.tsx`), and hosts with no client root at all are unchanged.

- 7f5d502: `vendo init`'s two dependency repairs — the provider install and the zod floor
  bump — now run with `pnpm add --ignore-workspace` when the host is an
  independent pnpm project nested inside an unrelated pnpm workspace.

  pnpm picks its workspace root by walking up to the nearest
  `pnpm-workspace.yaml`, so an unqualified `pnpm add` in a repo that merely sits
  inside someone else's monorepo installs against that ancestor. Two ways that
  goes wrong: the ancestor's `overrides` rewrite the host's own pins (a host
  pinning `next@14.2.5` under an ancestor pinning `next: ">=16.2.11"` gets a
  next 16 tree), and under an older pnpm the add aborts against the ancestor's
  store, so init only warns (E-DEP-003) and the zod floor never applies —
  leaving the build red on `zod ./v4 not exported`.

  Membership is decided by the ancestor workspace's own `packages:` globs
  matched against the host's relative path, so a genuine member keeps ordinary
  workspace behavior even if it carries a stale leaf lockfile, and a host that
  has never installed is still recognized as a non-member. A pattern form the
  reader does not model resolves to "member", which is the pre-existing
  behavior.

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
- Updated dependencies [0e46cd5]
- Updated dependencies [079d7d8]
- Updated dependencies [29c2b49]
- Updated dependencies [ed44a58]
  - @vendoai/core@0.10.0
  - @vendoai/apps@0.10.0
  - @vendoai/actions@0.10.0
  - @vendoai/store@0.10.0
  - @vendoai/mcp@0.10.0
  - @vendoai/ui@0.10.0
  - @vendoai/agents@0.10.0
  - @vendoai/knowledge@0.10.0
  - @vendoai/harnesses@0.10.0
  - @vendoai/automations@0.10.0
  - @vendoai/guard@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [7207bb6]
- Updated dependencies [7207bb6]
- Updated dependencies [4fa477a]
- Updated dependencies [18c77cd]
  - @vendoai/ui@0.9.0
  - @vendoai/telemetry@0.5.0
  - @vendoai/core@0.9.0
  - @vendoai/actions@0.9.0
  - @vendoai/agents@0.9.0
  - @vendoai/apps@0.9.0
  - @vendoai/automations@0.9.0
  - @vendoai/guard@0.9.0
  - @vendoai/harnesses@0.9.0
  - @vendoai/knowledge@0.9.0
  - @vendoai/mcp@0.9.0
  - @vendoai/store@0.9.0

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

- 8af0712: A project file may no longer choose the coding-agent endpoint. `readEnvFiles` — the CLI's one dotenv reader — now drops `ANTHROPIC_BASE_URL` from `.env` and `.env.local`; only the developer's own shell (or an explicit programmatic env) may set it. Before this, `vendo init` on a freshly cloned repo would send its source-bearing extraction prompts (catalog entries plus verbatim quotes from the host's own files) to whatever endpoint the repo's `.env` named, whenever the developer had no Anthropic credential of their own — a repo-supplied bare base URL counted as an own credential on every Claude rung, which also suppressed the Vendo Cloud gateway that would otherwise have carried the run. This is a deliberate security-posture change, not a bug fix: a repo that relied on `.env` to point Vendo's extraction at a corporate gateway must now export `ANTHROPIC_BASE_URL` in the developer's shell instead. Nothing else moves — a shell `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` still reaches an engine on every path, including `vendo sync --ai` on an incremental run.
- e092567: A standalone session can reopen an existing conversation.

  `session(subject, { threadId })` reopens the named conversation instead of minting
  a new one. Ownership is the store's own subject scope — someone else's thread reads
  back as absent and is refused as `not-found`, never silently swapped for a new
  conversation. The resume path deliberately skips `threadStore.put`, whose replace
  semantics would delete the very transcript the resume exists to read back.

  Until now `createSession` minted a fresh thread on every call and `SessionOptions`
  had no way to name an existing one, so a Node backend that built a session per HTTP
  request — which is what the README showed — lost the whole conversation on every
  request. Multi-turn only worked while the JS object stayed alive in process memory.
  The README now passes `threadId` in, hands `session.threadId` back out, and says
  plainly that a session is request-lifetime while the thread is not.

  The `[User]` and `[Situation]` prompt blocks are now one implementation in
  `@vendoai/core` (`userPromptBlock`, `situationPromptBlock`, `promptFactLines`),
  shared by the standalone assembler and the umbrella's. They were two copies of a
  prompt-injection defence — the indent that stops a client-supplied fact from
  forging a top-level `Directions` section — and only the umbrella's labeled the
  situation "observation, not instruction". The shared block carries that label, so
  the standalone surface gains it. No other behaviour changes.

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

- b99147f: Connect asks first: a `request_connection` tool and a connect card that owns the whole answer.

  The agent can now ASK for a connection instead of spending a call it already knows
  will be refused. `request_connection` (toolkit + one plain sentence) mints exactly the
  `connect-required` outcome a refused service call produces, so the card the user sees
  is the same card — nothing new on the wire. The tool is projected only where the
  deployment can actually connect the toolkit, and refuses one it cannot rather than
  raising a button that can never succeed.

  The card itself now opens its sign-in window _inside the click_, before any `await`:
  Safari and Firefox judge a popup by call-stack provenance, and the old order (initiate,
  then open) is precisely the shape they block. The window opens centered and blank, is
  navigated when the redirect URL arrives, and is closed from the opener once the account
  goes active. A window the browser blocked anyway is no longer a dead end — the same
  poll keeps running behind an "Open sign-in in a new tab" link.

  The card also says what connecting grants, in plain words rather than OAuth scope
  strings, and offers "Not now" — which leaves a one-line Skipped record that still
  re-offers Connect, and tells the agent so it can adapt.

- 022f789: The automations adoption handoff is removed. When an automation's sponsorship
  lapsed — the sponsor left, lost their permissions, or somebody else edited the
  app — the automation stopped and an "adoption card" waited inside the app so the
  next editor could take it on, re-approving its reads and writes as themselves.
  No host used it.

  Sponsorship itself is unchanged: an automation still runs as a named person, and
  still stops when that person's authority lapses. What goes is the second half —
  the handoff to somebody new.

  Gone: `AutomationsEngine.adoption()` and `.adopt()`, the `AdoptionCard` and
  `AdoptionNeed` types (`@vendoai/automations`); `ADOPTION_VENUE_KEY`
  (`@vendoai/core`); `POST /automations/:id/adopt/:triggerId` (`@vendoai/vendo`);
  `client.automations.adopt()`, `<AdoptionCard>`, `<AdoptionVenueCard>`,
  `ADOPTION_VENUE_KEY`, `AdoptionCardProps`, `AdoptionVenue` and `AdoptResult`
  (`@vendoai/ui`).

  Pre-1.0 hard cut, no deprecation shim. A stopped automation is restarted the way
  it was armed in the first place: anyone who can edit the app calls `enable()`
  again, which re-approves its reads and writes under the new sponsor. The stopped
  sentence the run row and the list carry now says "anyone who can edit this app
  can turn it back on" instead of "…can take it on".

- 53717c4: Remove the retired `vendo playground` command's dead server and the inert refine panel.

  `startPlaygroundServer` (and the `/playground.js` + `/embed.js` routes it served)
  is gone, along with the IIFE entry `app/main.tsx` and the playground half of the
  vite bundle step. `browserOpenCommand` — the one live export of the deleted
  module — now lives in `cli/shared.ts`. The bundle step no longer runs as
  `prebuild`/`pretest`/`pretypecheck`/`pretest:coverage`; the still-live docs embed
  bundle is built on demand by `pnpm --filter @vendoai/vendo run build:embed`.

  The try surface itself is unchanged: `@vendoai/vendo/try-surface` and
  `@vendoai/vendo/try` keep their exports and their behaviour.

  Breaking: the try profile's `capabilities.refine` field is removed. It was
  always `false`, and the `/api/refine` endpoints its panel called exist nowhere.

- d3e7dcd: The voice stage is removed. `@vendoai/ui` shipped a live WebRTC voice surface —
  an animated presence orb, a rolling caption ticker, a transcript drawer, a
  consent bar that accepted a spoken "approve", and a `vendo_act` bridge that ran
  a real guarded agent turn mid-call. Nothing mounted it: the demo host un-docked
  `<VendoStage />` on 2026-07-30, and no example, fixture, or docs host has
  rendered it since.

  Gone from `@vendoai/ui`: the `@vendoai/ui/voice` entry point in its entirety
  (`realtimeVoiceDriver`, `createVoiceActBridge`, `VoiceDriver`,
  `VoiceDriverEvent`, `VoiceDriverHandlers`, `VoiceSessionHandle`,
  `VoiceSessionView`, `RealtimeVoiceDriverOptions`, `VoiceActBridgeOptions`),
  `useVoice` and `UseVoiceResult` from the root entry, `<VendoStage />` from
  `@vendoai/ui/chrome`, and the `voice` prop on `VendoProvider`. Gone from
  `@vendoai/vendo`: the `useVoice` / `UseVoiceResult` re-exports on
  `@vendoai/vendo/react`.

  Pre-1.0 hard cut, no deprecation shim. Nothing else changes: the thread
  composer keeps its optional `onVoice` callback, so a host that wants a mic
  button still gets one and wires it to its own surface.

- 9b72f48: Remove tour mode.

  Tour mode had no consumer: not the demo host, not the framework examples, not
  the docs beyond its own page — only its own tests. The demos that need a
  scripted walkthrough each hand-write one against their own host, which is the
  shape that actually shipped. Pre-1.0, so this is a hard cut with no shim.

  Removed from `@vendoai/vendo/server`:

  - the `tours` config option on `CreateVendoConfig` (`tours?: readonly TourEntry[]`)
  - the `TourEntry`, `TourResponse`, `TourPart` and `TourApp` type re-exports
  - `ScriptedTurn` and the `scripted` seam on `HarnessTurnsConfig`, whose only
    producer was tour mode

  A host that passed `tours` gets a type error naming the removed key; there is
  no replacement, and no other configuration changes.

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

- 38e36a0: `vendo doctor` stops asserting a cause for a `404` from the doctor probes and reports what it actually observed instead. Since the probe surface became development-only, a composition that never declared itself development answers `404` on `POST /doctor/present` and `POST /doctor/act-as` — and doctor read that `404` as a credential failure, telling the reader to "set `VENDO_BASE_URL` to the running host origin" (`auth/present`) or to "check `createVendo({ actAs })`, its verifier middleware, and the host principal resolver" (`auth/act-as`). Both were false: the credentials and the actAs wiring were fine, the route simply was not in the table.

  But a bare `404` does not prove the opposite either, and nothing doctor can observe does. `GET /doctor/base-url` is the best evidence available — every composition mounts it in every environment, while the probes beside it are development-only — so doctor now asks it, and only a Vendo-shaped `{ ok }` body counts as an answer from the wire (an HTML catch-all, an auth layer and a proxy error page all reply `200`, `401` and `500` at any path on an origin without a Vendo route table behind them). Even then it is evidence, not proof: a real Vendo deployment that is simply not the one you meant — a stale base URL aimed at staging — answers `/status` and `/doctor/base-url` exactly like your own dev server with the gate closed.

  So both messages name the candidate causes in likelihood order and give the step that separates them. When base-url answers like a wire: most likely the composition never declared itself development — pass `createVendo({ development: true })`, or run it with `NODE_ENV=development`, which `next dev` sets for you and a plain `node`/`tsx` server does not, then restart and re-run doctor; if the probes still `404`, the URL is a real deployment but not the dev server you meant. When it does not: most likely this is not the app's Vendo wire base, with the observed status quoted, pointing at the origin, the full mount path, and any proxy, auth layer or catch-all in front of it. The extra request is made only when a probe actually `404`s. Every other failure path keeps its existing message, and no route becomes reachable that was not reachable before: this is diagnosis only.

- c3b7589: The `vendo doctor` probe routes are now mounted only in a development composition, and are not in the route table at all anywhere else. They used to be mounted on every deployment behind a per-request `environment("NODE_ENV") === "production"` refusal — a check that answers "not production" for an unset `NODE_ENV` and on every runtime without a `process` global (edge, Workers). Either of those served the whole probe surface to an anonymous caller, and none of these routes requires a principal: `GET /doctor/machines` enumerates every machine-bearing app in the deployment across every subject (id, name, provisioned-at, whether its sandbox is awake right now, and each declared cron plus the function it fires) and reports whether `VENDO_TICK_SECRET` guards the `/tick` surface; `GET /doctor/mcp` reports the composition's broker selection; `POST /doctor/act-as` makes the composition mint host `actAs` material for a synthetic principal and call the host API with it, on demand, from an unauthenticated request; `POST /doctor/present` forwards the caller's own credentials to the host API. Absence of configuration now means closed. What arms them is `createVendo({ development })`, which `NODE_ENV=development` already sets — the dev server `vendo doctor` talks to is unchanged. `GET /doctor/base-url` is untouched and still answers in every environment: it reports a static composition fact and exists to catch a production misconfiguration. A `vendo doctor --url` run against something that is not a development composition now reports the auth probes as failing and skips the machine/broker sections, instead of answering; set `development: true` on that composition if the probes are wanted there.
- 0d8f419: Internal refactor: the CLI's longest functions are split into the steps their
  own section comments already named. `runDoctor` becomes an itinerary over
  per-section check modules, `runJudgmentPass` a pipeline of named stages,
  `runInit`/`buildPlan` their labelled steps, `runSyncFlow` its five stages, and
  `main` a flat command table. Behaviour, output text and exit codes are
  unchanged, and no public surface changed: every exported name, signature and
  module path is identical.
- 5f643c7: The in-process tool pack's `vendo_make` takes `slot`, like the MCP door's.

  A host whose own agent runs in process could not say where a screen should land:
  `slot` was on the door's `vendo_make` and missing from the pack's. It is now on
  both, with the door's own wording, and reaches the same handler — the placement
  claim rides `vendo_make`'s mint whichever door called it, so there is no second
  path to keep honest. The pin tools stay door-only; on Path A you still move an
  existing view from your own code with the app id.

- c05d1da: An explicit `mcp.serviceAuth` keeps the door's own token endpoint. Setting it is a
  choice of LOCAL authorization server — the RFC 8693 exchange it opens exists only
  at the door's own `{mount}/token`, which a broker-fronted door does not serve — so
  a declared `VENDO_MCP_BROKER_URL` no longer displaces it. That variable is a
  default, and a default never overrides what the composition passed.

  A deployment that set both used to compose a broker-fronted door and log a warning,
  which is the whole failure: the host's configured service-key exchange 404'd at
  runtime with nothing but a boot-time line explaining why, and the backend calling it
  saw only `not-found`. The broker URL is still parsed either way, so a malformed one
  keeps failing loudly rather than dropping to a local door by accident. An explicit
  `mcp.remoteAs` alongside `mcp.serviceAuth` is unchanged: `remoteAs` wins and the
  warning now names it as the one thing to drop.

- 8792ab9: Decompose `createVendo` into one module per composition phase. Pure refactor:
  the public surface of `@vendoai/vendo` and `@vendoai/vendo/server` is unchanged
  — every type and value the entry exported is still exported from it, and no
  importer outside the package changes.
- d31d2bf: `POST /sync/impact` is now mounted only in a development composition, and is not in the route table at all anywhere else. It used to be mounted on every deployment and refuse per-request on `environment("NODE_ENV") === "production"` — a check that answers "not production" for an unset `NODE_ENV` and on every runtime without a `process` global (edge, Workers). Either of those served the route to an anonymous caller, and the route takes no principal: for up to 200 tool names per request it reads the deployment's entire `vendo_apps` and `vendo_grants` collections and returns the id and title of every enabled app and automation referencing each tool, across every subject, plus the count of live standing grants on it. Absence of configuration now means closed. What arms it is `createVendo({ development })`, which `NODE_ENV=development` already sets — the dev server `vendo sync` talks to is unchanged, so a normal `predev`/`prebuild` sync still prints its blast radius. A deployment that ran `vendo sync --url` against something that is not a development composition now gets `impact unknown` instead of an answer; set `development: true` on that composition if the probe is wanted there.
- d24162c: Fourteen correctness fixes on the umbrella — the package hosts actually install.

  Two of them touch what leaves a machine. Pinning `VENDO_DEV_CREDENTIAL=vendo-cloud`
  without a `VENDO_API_KEY` used to return the cloud rung anyway, and the gateway call
  was then made with `apiKey: undefined` — `@ai-sdk/anthropic` falls back to
  `process.env.ANTHROPIC_API_KEY`, so the host's own provider key was sent to
  console.vendo.run. The pin now degrades to `none`, which is what the docs already
  promised. And composing a Vendo minted a persistent, opted-in telemetry id into
  `~/.vendo/telemetry.json` on first boot, whether or not telemetry was ever enabled and
  whether or not anything could ever be uploaded; that identity is now read only when the
  Cloud slot is filled, and local-only capability misses carry no identity at all.

  The served-app proxy rebuilt its forwarded path from percent-decoded segments, so an
  encoded `/` or `?` in a URL turned into a real separator inside the box's request. A
  host pointing `profileDir` at its own `.vendo` directory silently lost theme, brief,
  catalog, knowledge and its pin baselines. `vendo sync` answered "no saved references"
  for tools that live generated app code calls, because it never read the compiler's
  `componentTools` manifest. A repeated tool name from the console took down the host's
  entire tool registry. The vendo verbs flattened their own written-for-the-model refusals
  ("this app has no schedule to change — ask for the automation first") into "could not
  complete, try again".

  On the CLI: `vendo doctor` failed every Pages-Router host forever and told it to edit a
  file that does not exist — it and `vendo init` now share one answer for where the mount
  belongs. Doctor also hung for up to two minutes after printing its verdict when the dev
  server failed to spawn. Theme extraction let an `@import`ed stylesheet override the
  sheet that imported it, reporting the wrong brand colour as an exact read. The judge
  discarded its best-evidenced grades as "no evidence" when the quote ran long, and could
  not repair the commonest truncation of all. `vendo init` ran a package install on
  workspaces that already had the dependency hoisted, and pointed users at a docs path
  that only exists inside this repo. Auth0 tenants configured with a trailing slash could
  not log in at all.

- 66d7db5: The playground's `page` scenario is replaced by the two panels a host still mounts itself.

  `VendoPage` is being cut, so the scenario that mounted it (`#page`, "Workspace
  console") goes with it. What it uniquely showed that no other scenario did was
  the automations list and the connected-accounts settings, so those become
  scenarios of their own against the same fake wire client: `#automations-panel`
  (`AutomationsPanel`) joins the Automations group, and `#accounts`
  (`ConnectedAccountsPanel`) opens a new Accounts group. The `Page` group is gone.

  Breaking for `mountScenario`/`VendoDocsEmbed.mount` callers: `scenario: "page"`
  now throws `unknown scenario`. The console shell itself — the conversation-history
  rail, the app shelf, and the Apps door — is no longer demonstrated anywhere,
  because it is no longer shipped.

- 18d35bd: `vendo sync --ai` on an incremental run now reaches an engine on Claude Code's own-credential env vars (`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, a custom `ANTHROPIC_BASE_URL`), which both Claude harnesses already accept. That one flag combination is the only path that falls back to the runtime credential resolver instead of sweeping the harness ladder, so it alone reported "no model credential" while `vendo init` and an interactive `vendo sync` ran fine on the same login. The runtime resolver itself is unchanged — product turns still require a real API key.
- a621123: Two checks stop reporting a verdict they never reached.

  `vendo doctor`'s render probe GETs the app origin's `/` and never reads the body, so a
  status line is the whole observation. It failed on 5xx and blessed everything else as
  "the app's root page renders" — which made `ok: the app's root page renders (HTTP 404)`
  the line every healthy run printed, on the one status that means the server is saying
  there is no page here.

  A 5xx still fails `E-LIVE-006` unchanged; that is the crashing-site case the gate exists
  for. A 4xx is now a note that names the status and says no page was reached, because a
  host serving nothing at `/` — every page under a basePath, an auth layer in front — is
  healthy, and doctor cannot tell that from a route you meant to have. That is the same
  judgement the probe's own unreachable-origin branch already declines to make. A 2xx
  passes as "answered HTTP 200": true, and the most this probe can know.

  In the screen agent, a save that landed bytes the render seam would not paint was told
  "validate found nothing to fix". `validateWrittenApps` is fail-open by design and returns
  no failures both when validate passed and for every way it could not reach a verdict — a
  guard that denied the call, an answer it cannot parse, a workspace that closed under it,
  each reported to the operator only. The hand cannot tell those apart, so it no longer
  claims to: it states the failed paint, which is the fact it has. When the gate did produce
  findings, the note is still the repair instruction verbatim.

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

- 9e14651: Delete `@vendoai/engine`; init's `--engine npx` rung now fetches Anthropic's
  published `@anthropic-ai/claude-code` instead.

  The rung's user-facing behaviour is unchanged — last resort, one-time ~250MB
  `npm exec` fetch disclosed before it starts, read-only Read/Glob/Grep over the
  host root, own credential or the Vendo Cloud gateway — but it now spawns the
  same binary as the PATH rung rather than a Vendo-published wrapper around the
  Agent SDK. The credential label reads "via npm-fetched Claude Code" instead of
  "via the Vendo engine".

  The engine's path-confinement guard moves up to the ladder level
  (`cli/extract/confine-to-root.ts`) and now covers every Claude rung, in the two
  forms those rungs can enforce:

  - The Agent SDK rung wires `confineToolToRoot` as its `canUseTool` callback, so
    a prompt-injected `Read ~/.aws/credentials` is denied there too. It passes
    `tools` rather than `allowedTools`, because a blanket allowlist auto-allows
    and never consults the callback.
  - The two CLI rungs — the `claude` binary on PATH and the npm-fetched one —
    have no callback to hand a subprocess, so they now pass root-scoped
    permission rules (`Read(//<root>/**)` and friends) instead of the bare tool
    names they used to. A bare `Read` on `--allowedTools` is the CLI's own
    version of the blanket auto-allow: it permits Read on ANY path. Both rungs
    previously let a repo-derived prompt ("the config lives at
    `../outside/secret.txt`") read outside the extraction root and hand the
    contents to the model provider; the CLI matches these rules against both the
    path the model supplied and the path it resolves to, so a `..` climb and an
    in-root symlink pointing outside are each denied.

- Updated dependencies [a7a0fcf]
- Updated dependencies [4772c49]
- Updated dependencies [1e27609]
- Updated dependencies [1ad9c74]
- Updated dependencies [2ab4a39]
- Updated dependencies [f411174]
- Updated dependencies [38b32a3]
- Updated dependencies [f896726]
- Updated dependencies [e092567]
- Updated dependencies [dd441cb]
- Updated dependencies [2fd14aa]
- Updated dependencies [898eb8f]
- Updated dependencies [15f4759]
- Updated dependencies [464dce8]
- Updated dependencies [b99147f]
- Updated dependencies [46923cc]
- Updated dependencies [b50a766]
- Updated dependencies [f25138f]
- Updated dependencies [022f789]
- Updated dependencies [d3e7dcd]
- Updated dependencies [354f231]
- Updated dependencies [ee92750]
- Updated dependencies [d599d23]
- Updated dependencies [a69aa5c]
- Updated dependencies [89660d1]
- Updated dependencies [4ec9c17]
- Updated dependencies [7163a25]
- Updated dependencies [f1b30a1]
- Updated dependencies [3e2b35e]
- Updated dependencies [c41de74]
- Updated dependencies [5724311]
- Updated dependencies [1022b2f]
- Updated dependencies [2b6d60f]
- Updated dependencies [fed58ab]
- Updated dependencies [13e2452]
- Updated dependencies [b99147f]
- Updated dependencies [7f35f23]
- Updated dependencies [ca3a9dc]
- Updated dependencies [12a344c]
- Updated dependencies [b99147f]
- Updated dependencies [d4a2d4c]
- Updated dependencies [5e8a141]
- Updated dependencies [0f6455a]
- Updated dependencies [dd441cb]
- Updated dependencies [8f3d23a]
- Updated dependencies [5e584c8]
- Updated dependencies [5724311]
- Updated dependencies [be9f3e9]
- Updated dependencies [0039efe]
- Updated dependencies [2b49b64]
- Updated dependencies [2b49b64]
- Updated dependencies [6fb568a]
- Updated dependencies [f260c10]
- Updated dependencies [a621123]
- Updated dependencies [7288546]
- Updated dependencies [2357b22]
- Updated dependencies [bd4248d]
- Updated dependencies [65de3c6]
  - @vendoai/mcp@0.8.1
  - @vendoai/core@0.8.1
  - @vendoai/actions@0.8.1
  - @vendoai/ui@0.8.1
  - @vendoai/guard@0.8.1
  - @vendoai/apps@0.8.1
  - @vendoai/automations@0.8.1
  - @vendoai/agents@0.8.1
  - @vendoai/store@0.8.1
  - @vendoai/harnesses@0.8.1
  - @vendoai/knowledge@0.8.1
  - @vendoai/telemetry@0.4.1

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

- c9df3f7: `instant()`, the default-route flip, and the consolidated `createVendo` surface.

  **`instant()` — the non-agentic specialist.** `@vendoai/harnesses` gains a
  second built-in thinker for hosts that want speed as the resident. One routing
  call sorts the ask into create / edit / act / cannot; an app ask goes STRAIGHT
  to the guarded apps tool, so the plan — which is the layout — reaches the screen
  while a resident thinker would still be forming its first sentence. Non-app asks
  act through the same guard door, capped at two steps so it is never a thinking
  loop. Genuinely impossible asks refuse in the consumer's voice. Every host
  effect goes through `turn.tools.call()`, so the guard, the audit row, the
  approval card, the view channel and the transcript mirror are unchanged — the
  specialist buys speed, never a second safety story.

  ```ts
  import { createVendo, instant } from "@vendoai/vendo/server";
  const vendo = createVendo({ auth: authJs(), harness: instant() });
  ```

  **`POST /threads` now runs through the harness runtime for every host** — the
  host's harness when they named one, `vendo()` when they did not. The rails that
  kept this opt-in (`find_tools`, the connection-scoped loadout, the curated menu,
  capability-miss detection) all reach the harness path, and the assembled system
  prompt rides the turn. Deployments whose store has no SQL handle (the Cloud
  hosted store, or a host's own non-SQL adapter) stay on the shipped agent path,
  because the transcript and workspace are tables.

  **The config surface is consolidated onto §10's eight slots** — `auth`, `tools`,
  `harness`, `packs`, `models`, `store`, `files`, `sandbox`. Additive only; no
  shipped host breaks:

  - NEW `tools:` — the host's own tool declarations in memory, the same
    `ExtractedTool[]` `vendo init` / `vendo sync` write to `.vendo/tools.json`.
    Precedence: `tools:` → `profile.tools` (now deprecated) → the file.
  - `model` → `models.default`, `paint` → `models.fill`, `profile.tools` →
    `tools:`. All three still work for one more minor and warn once, naming the
    move.
  - Every one of the 33 top-level keys has a stated destination, and the table is
    gated: a key added to the config without a documented destination fails a
    test.

  Also: the docs-rot gate on `handler-options.mdx` is real again. Its
  exhaustiveness assertion lived in a test file, which this package's tsconfig
  excludes from typecheck — so it never compiled and the documented key list sat
  ten keys behind the interface. The list moved into `src/config-keys.ts`, where
  both directions of the assertion actually run.

- 7c12970: `vendo knowledge sync` now pushes to the engine the composed server would
  read, and says which one it chose.

  Engine selection mirrors `selectKnowledge` (server.ts), restricted to what a
  CLI can know: an injected adapter wins; otherwise `VENDO_API_KEY` means Vendo
  Cloud (honouring `VENDO_CLOUD_URL`), so sync pushes over the existing
  `vendo/knowledge-wire@1` /upsert + /remove; with no key it stays on today's
  local lexical engine over `.vendo/data`.

  Before, a Cloud-keyed project synced its docs into a _local_ store while its
  agent searched Cloud — the docs went somewhere the server never read, and
  nothing said so. Both the plan line and the result line now name the target:

  ```
  Synced: 3 upserted, 1 removed, 128 unchanged → Vendo Cloud (console.vendo.run)
  Synced: 3 upserted, 1 removed, 128 unchanged → local store (.vendo/data)
  ```

  No new flags or config: the key you already have decides, the same way it
  decides for the server.

- 6eb8a04: **BREAKING:** the knowledge entailment verifier is removed. The knowledge
  stack is a pure retrieval plug-in again, and `weakScoreThreshold` is once more
  the sole refusal calibration — unchanged, and still the knob to tune.

  The check shipped off by default and the live measurement is why it never got
  turned on: over the 94-question corpus it still answered 7-10 of 34
  unanswerable questions per pass, while costing a model call per search and
  seconds of latency on a call the user waits through. It never cleared the bar
  it existed for, so it is gone rather than left as a knob nobody should set.

  Removed surface:

  - `@vendoai/knowledge`: `entailmentVerifier`, `KNOWLEDGE_VERIFY_TIMEOUT_MS`,
    `KNOWLEDGE_VERIFY_TURN_BUDGET_MS`, the `KnowledgeVerifier` /
    `KnowledgeVerdict` / `KnowledgeVerifierInput` / `KnowledgeVerifierPassage` /
    `KnowledgeVerifyOptions` / `EntailmentVerifierOptions` types, and the
    `verifier` + `verifyTurnBudgetMs` options on `createKnowledgeTools`. The tool
    reverts to its pre-verifier decision rule: chat search → one deep retry on
    weak evidence → structured `insufficient-evidence`.
  - `@vendoai/core`: the `verifier` model seat (`Seat`, `SEATS`,
    `ResolvedModels`, `migrateModelSeats`) and the `unverified` field on the
    `data-vendo-citations` stream part.
  - `@vendoai/vendo`: the `VENDO_KNOWLEDGE_VERIFY` and
    `VENDO_MODEL_KNOWLEDGE_VERIFIER` environment knobs, and the
    `models.verifier` / `models.knowledgeVerifier` slots.
  - `@vendoai/ui`: the amber "I couldn't check this answer against the
    documentation" line. The engine-outage flag and the structured
    searched-line are untouched.

- 6c1273a: A keyed host's MCP door now fronts itself with the hosted broker — zero config.

  **The broker default (adapter rule).** With `mcp` enabled, `VENDO_API_KEY` set,
  and a public `VENDO_BASE_URL`, composition ensures a broker tenant at
  `{slug}.mcp.vendo.run` through your Vendo Cloud console and wires the door's
  `remoteAs` + `federation` from the response — the same way the key already
  fills the store, sandbox, inference and connections slots. An explicit
  `mcp.remoteAs` in config still wins verbatim, and a host with no key (or no
  public URL — localhost, `*.local`, and private addresses can't be fronted by
  the broker) keeps today's local door byte-for-byte. The ensure call is
  idempotent and rides the boot-once ready latch, so composition stays I/O-free
  at module init (Workers-safe); if the console blips at boot, the door falls
  back to its own local OAuth surface with one loud warning instead of dying.

  **`/status` says which door composed.** `blocks.mcp` is now a posture —
  `"local"`, `"broker"`, or `false` — following the `blocks.connections`
  pattern. Older clients that only checked truthiness keep working.

  **Doctor explains the silent cases.** A key + an open door + no public base
  URL prints the new `I-CLOUD-002` informational ("the hosted MCP broker
  activates when the deployment has a public base URL"); with a public URL,
  doctor resolves and prints the tenant your door composes against.

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

- f7c6da2: Delete `@vendoai/agent`: one engine, one path, one home.

  The old `createAgent()` chat engine survived for one reason — hosted-store
  deployments could not serve harness turns, so they silently fell back to it.
  They can now, so the legacy path, its runner and `agent.stream` are gone and the
  harness runtime serves every turn. Nothing a client can see changes; the
  wire-parity suite is the proof.

  Breaking changes:

  - @vendoai/agent (whole package) → harnesses (runtime/loop/rails) + vendo
    (pack/prompt/threads)
  - createAgent/AgentConfig → createVendo harness path
  - VendoAgent type → none; HarnessTurns is the surface. Vendo.agent property →
    Vendo.harness
  - asRunner()/createRunner → awayRunner (composed internally for vendo_delegate)
  - supervise hook → dropped
  - memory-store fallback in the turn door → loud per-turn refusal
    (memoryStoreAdapter itself stays in core/conformance)
  - WireDeps.agent → WireDeps.harness (required)
  - Thread/ThreadSummary, tokenBudgetStop, ScriptedTurn, pack consts → new import
    homes (@vendoai/vendo, @vendoai/harnesses)
  - Behavior: vendo_delegate persists a thread + workspace per delegation (was
    stateless)
  - Behavior: POST /threads on a no-SQL/no-ops store → loud not-implemented error

  Also fixed on the way out: a failed turn whose harness threw (rather than
  reporting an `error` event) answered with one generic constant, so a keyless
  deployment was told "something went wrong" instead of to run `vendo login`, and
  nothing was persisted. Both runtime paths now pass the error through the same
  `wireErrorMessage` gate the legacy door used, and raise the same two carriers —
  the error chunk and the persisted `data-vendo-turn-error` part.

- dd1042c: **BREAKING:** the tool pack's app door is `vendo_make`, not `vendo_create_app`.

  A BYO loop and a third-party agent at the MCP door now call the SAME tool, with
  the same name and the same arguments. The pack's built-in used to be a second
  public tool with its own name and a single `prompt` field, translated to
  `vendo_make`'s `request` on the way in — two contracts for one capability, and
  the one your model saw was the one the docs did not describe.

  - `vendo_create_app` → `vendo_make`. There is no alias; a loop that hardcodes the
    old name in `include`/`exclude`, or a prompt that names it, must be updated.
  - The tool's input is `vendo_make`'s own: `{ request }` required, `context` and
    `app` optional. `prompt` is gone; pass `request`.
  - `VENDO_CREATE_APP_TOOL` is replaced by `VENDO_MAKE_TOOL` (re-exported from
    `@vendoai/core`) on `@vendoai/vendo/ai-sdk` and `@vendoai/vendo/mastra`.

  Return shape is unchanged: a `vendo/app-ref@1` envelope with status `"building"`,
  returned fast while the build streams over the wire.

- 2ed91b0: **BREAKING:** the pack concept is gone. Capability arrives on `tools` and
  `skills`, and app generation and automations mount themselves.

  A pack was a labelled bundle of four lists, and every one of those lists already
  had a home of its own: tools → the one registry, skills → the workspace mount,
  checks → the checking floor, components → the catalog. The label bought a noun,
  a `definePack` handle, a provider function shape, a client-side second import,
  and a default list — and nothing else. A developer should never have to learn
  it; they already know "tools" and "skills".

  - `createVendo({ packs })` is removed. `tools:` now takes executable
    `ToolDefinition` entries alongside the `vendo sync` declarations it already
    took (told apart by `execute`), and `skills:` is new — SKILL.md values mounted
    at `/host/skills`. Checks keep arriving through `apps.checks` and components
    through `catalog`, exactly as a host already writes them.
  - `definePack`, `PackProvider` and `Pack` are removed; `PackSkill` is renamed
    `Skill` and kept as a deprecated alias for one release. `<VendoRoot packs>` is
    removed — components were always passable through `components` directly.
  - The boot-time collision check survives verbatim in the composition merge: two
    contributors claiming one tool or skill name is still an error at boot that
    names both, and a contributor claiming one of the host's own extracted tool
    names still refuses to compose.
  - New: `apps: false` unmounts app generation (`vendo_make`, the `vendo_apps_*`
    tools, the `building-apps` skill and the `/apps` wire surface are absent, not
    refusing), and `automations: false` unmounts automations (`/automations`,
    `/runs` and `/webhooks` answer not-found, `vendo.emit` refuses, nothing fires,
    and THE LAW's unattended-irreversibility rule leaves the reviewer's rubric).
    Both mount by default.
  - `@vendoai/automations` now exports `UNATTENDED_IRREVERSIBILITY_RULE` and
    `unattendedIrreversibilityCheck` — the rule moved to the block whose law it is.
    It joins the reviewer's rubric by default now that it rides the subsystem
    rather than an opt-in pack.

  A default `createVendo()` composes exactly the tool set and skill set it did
  before, asserted against literal lists in `default-composition.test.ts`.

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

- 98eba22: A streaming turn never goes silent, and a turn whose client vanished can be
  rejoined.

  **SSE keepalive.** A turn's first byte waits on a provider call and a slow tool
  streams nothing for its whole duration, so the wire could sit quiet long enough
  for a proxy or a browser to drop the connection. Every turn response now leads
  with an SSE comment frame and gets one per 15s of silence. `@vendoai/core` gains
  `withSseKeepalive`, `startSseKeepalive`, `SSE_KEEPALIVE_FRAME` and
  `DEFAULT_SSE_KEEPALIVE_INTERVAL_MS`; both engines' responses use it, and the
  `vendo try` dev server's own copy is gone.

  Hosts may notice: **the SSE body now contains comment frames.** They are ignored
  by the SSE grammar, so `useChat`, `DefaultChatTransport` and any spec-compliant
  parser see an unchanged message sequence — but a hand-rolled reader that assumes
  every frame starts with `data: ` needs to skip lines beginning with `:`. This is
  not a new event: there is no new `HarnessEvent` member and no new
  `data-vendo-*` part.

  **Stream resume.** The client half already shipped in `ai@6`
  (`ChatTransport.reconnectToStream`, which `useChat().resumeStream()` calls) and
  had no server to talk to, so a reload mid-turn painted the user's question and
  nothing else. The wire gains `GET /threads/:id/stream` — the SDK's own URL,
  method and 204 contract — serving the turn from the start of the stream and then
  following it live. Recording is per-turn, in memory, byte-capped, and dropped 30s
  after the turn settles; the persisted transcript remains the durable record.

  `useVendoThread` now resumes automatically after it loads a thread's transcript,
  and returns `resumeStream()` for surfaces that reconnect on their own.

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

- a004031: **BREAKING:** the hidden `vendo try` CLI command is removed, along with the
  local try server and the pipeline that fed it (`cli/try.ts`, `cli/try/server.ts`,
  `cli/try/extract.ts`, `cli/try/deepen.ts`) and the retired refine engine
  (`src/refine.ts`) whose only remaining caller was that server. `vendo try` now
  falls through to the unknown-command error like any other unrecognized command.

  The command was already unlisted (help never named it — the pre-install
  `npx vendo try` pitch it fronted resolves no npm package), and the hosted try
  venue replaced its job: vendo.run/playground mounts the same surface against
  the console's profile/seeds/chat endpoints.

  Everything the hosted venue and the docs pipeline stand on is untouched:
  `@vendoai/vendo/try-surface` (the client surface, including the try-mode
  components), `@vendoai/vendo/try` (the try artifact schemas and
  `createSyntheticFetch`), and `startPlaygroundServer` with the playground
  bundle it serves.

### Patch Changes

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

- cfacf95: Security floor for `@auth/core`: the optional peer range moves from `^0.34.3`
  to `>=0.41.3`. The `authJs()` presets pass the raw incoming request to the
  host's `getToken()`, and `@auth/core` versions before 0.41.3 have a
  request-triggered CPU-exhaustion DoS in that call. 0.41.3 is the patched
  release; hosts on older Auth.js should upgrade `@auth/core` alongside this.
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

- 38dd824: The screen agent IS `vendo()`, and the checks floor rides the `vendo_make` route.

  ## `vendo()` takes a closed loadout

  `VendoHarnessDeps.tools` is new. Set, the equipped set is EXACTLY that list: a
  string equips that registry tool (guarded, through `turn.tools.call`, as today);
  a `HarnessHand` — `{ name, description, inputSchema, execute(input, turn) }` — is
  the harness's own hand, invisible to every other consumer. No discovery rail
  (`find_tools` is not mounted: a fixed loadout has nothing to discover), no
  `vendo_*` always-active exemption, no `hire_subagent` unless the list names it. A
  name the deployment's listing does not carry is simply not offered, because that
  list is written once at boot against a listing that legitimately varies per
  deployment.

  Unset — every existing caller — behaves exactly as before.

  `execute` receives the TURN, which is what lets a hand be declared where a
  `Harness` value is built (no run in sight) while its effects are per-run:
  `turn.workspace` is this run's files.

  ## The screen agent is configuration, not a second loop

  `screenAgent()` / `screenAssembler()` keep their doors, their brief, their
  `SCREEN_STEPS = 10` budget and their outcome semantics, but the bespoke
  `startTurn` drive underneath them is gone: they are now `vendo()` with a closed
  loadout and two hands (`save_app`, `escalate`). The step cap, the seat
  resolution, `wireErrorMessage`, the context knobs and the system precedence are
  the default harness's, so a rail cannot be fixed in one loop and stay broken in
  the other.

  ## Fixed: a screen assembled through `vendo_make` was never checked

  Composition wired the screen slot's render seam without the checks floor, while
  the harness-turn route passed `{ authoredApp, commitSource, floor }`. One seam,
  two answers: the same `app.vendo` — a binding naming a tool the host has not got,
  a prop the renderer drops — was refused on the harness route and painted on the
  `vendo_make` route, where it also compiled in the wrong dialect (no inline tool
  expansion, `bindingErrors: []` by construction) and never persisted its source.

  The screen slot now carries the same `floor` and `commitSource`. A blocking
  finding means nothing paints and the last good view stays, exactly as everywhere
  else; the write still lands, so `validate` can read it back and repair it. Hosts
  need no code change.

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

- Updated dependencies [2e792a1]
- Updated dependencies [963d980]
- Updated dependencies [b022eb3]
- Updated dependencies [4b6e362]
- Updated dependencies [10a2b44]
- Updated dependencies [1572060]
- Updated dependencies [a004031]
- Updated dependencies [21c8b10]
- Updated dependencies [3f98372]
- Updated dependencies [cfacf95]
- Updated dependencies [21c8b10]
- Updated dependencies [21c8b10]
- Updated dependencies [1bb535b]
- Updated dependencies [ab5d181]
- Updated dependencies [05ac24c]
- Updated dependencies [8d623ec]
- Updated dependencies [a004031]
- Updated dependencies [10a2b44]
- Updated dependencies [2722d81]
- Updated dependencies [f884bfe]
- Updated dependencies [d6f5e28]
- Updated dependencies [ab5d181]
- Updated dependencies [56e0cc3]
- Updated dependencies [a004031]
- Updated dependencies [6224a7e]
- Updated dependencies [a5293af]
- Updated dependencies [b022eb3]
- Updated dependencies [c9df3f7]
- Updated dependencies [4515c7f]
- Updated dependencies [6eb8a04]
- Updated dependencies [215bfcc]
- Updated dependencies [dcc08ab]
- Updated dependencies [fbf265b]
- Updated dependencies [f7c6da2]
- Updated dependencies [ce98c54]
- Updated dependencies [2ed91b0]
- Updated dependencies [1deaa5c]
- Updated dependencies [e6aaa7a]
- Updated dependencies [ab5d181]
- Updated dependencies [d0c3cc9]
- Updated dependencies [0197470]
- Updated dependencies [2819bcc]
- Updated dependencies [38dd824]
- Updated dependencies [798b618]
- Updated dependencies [8132329]
- Updated dependencies [10a2b44]
- Updated dependencies [d1ff923]
- Updated dependencies [98eba22]
- Updated dependencies [10a2b44]
- Updated dependencies [f7c6da2]
- Updated dependencies [14e8246]
- Updated dependencies [a004031]
- Updated dependencies [6a3d9e3]
- Updated dependencies [b576ab9]
- Updated dependencies [fbf265b]
- Updated dependencies [a004031]
- Updated dependencies [38a840d]
- Updated dependencies [a0dbfc6]
- Updated dependencies [39a7ecc]
  - @vendoai/core@0.8.0
  - @vendoai/apps@0.8.0
  - @vendoai/mcp@0.8.0
  - @vendoai/ui@0.8.0
  - @vendoai/guard@0.8.0
  - @vendoai/agents@0.8.0
  - @vendoai/harnesses@0.8.0
  - @vendoai/actions@0.8.0
  - @vendoai/automations@0.8.0
  - @vendoai/store@0.8.0
  - @vendoai/knowledge@0.8.0
  - @vendoai/telemetry@0.4.0

## 0.7.0

### Minor Changes

- 47c53e9: `vendo init` only ever creates files in your source tree.

  **The last two rewrites are gone.** Init used to regenerate
  `app/api/vendo/[...vendo]/vendo-actions.ts` whenever the detected `"use server"`
  surface moved, and to wire `serverActions` into an existing
  `app/api/vendo/[...vendo]/route.ts`. It still creates both — once, on the run
  where they do not exist yet — but a file you already have is never written
  again. When init finds a change it will not make, it prints it in the same
  framed block as the layout mount (naming the file and the exact lines),
  carries it in `--agent` as an `edits[]` array of `{file, lines, why}` alongside
  `mount`, and lists it in `manualSteps` and the agent tail.

  **The map is yours from creation on.** An existing registration map is compared
  only by the keys it registers, never byte-for-byte, so your formatting, your
  comments, your aliases and your own extra entries all survive — and a reworded
  comment in a Vendo release can never nag every existing install. A missing
  action prints just the entries to add, with aliases that continue your file's
  own `actionN` numbering. A route that passes a `serverActions` map it composes
  itself is left alone entirely, and no generated map is created beside it.

  **`vendo doctor` catches what you skip.** New `E-WIRE-009`: the host has live
  `"use server"` actions, but the registration map is missing entries or the route
  never passes `serverActions` **inside** its `createVendo({ … })` call. Nothing
  else went red for that before — the tools simply failed closed at execution
  time. Init and doctor resolve the wiring, the required action set and the map's
  completeness through the same shared helpers, so they cannot disagree; both
  honor `.vendo/overrides.json` and judgments, because a disabled tool is one the
  runtime never dispatches.

  `package.json` hooks are unchanged: that is Vendo-owned config, not your source.

- c0f43b1: `vendo init` never edits your source, and `vendo sync` owns the whole scan.

  **Init stops rewriting `app/layout.tsx`.** The auto-wire that wrapped
  `{children}` in `<VendoRoot>` is gone. Every file init writes is new and
  Vendo-owned (plus its own `package.json` hooks); mounting the visible surface
  is your paste, and the run ends with one framed block naming the exact file and
  lines. It also rides `--agent` as a `mount` object and the head of
  `manualSteps`, and `vendo doctor`'s `E-WIRE-004` now prints the same paste
  instead of describing it.

  **One AI rule, one flag pair, on both commands.** `--ai` forces the judgment
  pass on and `--no-ai` forces it off, on `init` and `sync` alike. With neither
  flag, an interactive run **asks every time** — no consent is persisted anywhere
  — and a non-interactive run skips, so CI stays deterministic and never spends.
  `--yes` and `--json` count as non-interactive; `--json` still emits exactly one
  object and never prompts. `--ai-polish` and `--no-watermark` keep working. The
  hooks init installs now carry the flag explicitly (`predev: vendo sync --no-ai`,
  `prebuild: vendo sync --strict --no-ai`), and re-running init upgrades the
  hookless entries an older init wrote without touching a `vendo sync` call you
  wrote yourself.

  **Sync re-extracts your theme.** `.vendo/theme.json` was init-only, so a
  rebrand never reached the agent. Sync now re-runs the deterministic scan and
  reconciles it, using a sibling merge base, `.vendo/theme.extracted.json` (what
  the scan produced last time — commit it alongside `theme.json`). A slot is
  machine-owned only with recorded proof, so anything you hand-edited — or that
  predates the base — is left alone and reported with both values; derived slots
  like `accentText` follow their source rather than the app's. `--theme-refresh`
  takes your app's values anyway.

  **Pin baselines reach Vendo Cloud.** With a key set, a normal sync (no
  `--report` needed) reconciles `.vendo/remixable/` with the `vendo_pin_baselines`
  collection the console's Remix reviews screen reads — pushing new and changed
  slots, deleting slots pruned locally. The captured component **source** crosses
  the wire, which is what makes a fork's diff reviewable. Keyless and BYO make no
  request at all, and a Cloud failure is a warning, never a failed build.

- 3cfde47: Seven self-serve fixes across the CLI: the install path stops lying, and the JS
  scaffolds run.

  **Plain-JavaScript hosts boot again.** The generated `vendo/server.mjs` carried
  two pieces of TypeScript — `kind: "user" as const` in the principal line and a
  `as Headers & { … }` cast around `getSetCookie` — so every Express, bare-Node
  and `--framework custom` host on a JS codebase died with `SyntaxError:
Unexpected identifier 'as'` on its first `node server.js`. Both expressions now
  follow the host's language, and Node's own parser gates them in CI.

  **`vendo doctor` names a stale install.** npm release-cooldown configs
  (`min-release-age`) silently resolve an old `@vendoai/vendo`, and nothing ever
  said so. Doctor now checks npm's `latest` and prints `warning: installed
@vendoai/vendo X is behind latest Y` with the upgrade command. Fail-soft: an
  offline, blocked or slow registry says nothing at all and never changes the
  exit code.

  **Two silent CI failures are loud.** `vendo mcp server-json` with missing flags
  used to fall into a readline prompt even on a piped stdin — a script or agent
  hung forever; it now exits 1 naming `--domain` and `--url`. `vendo sync
--report` without a Cloud key used to complain and exit 0, so a reporting lane
  stayed green while never reporting; it now exits 1.

  **`vendo try` is unlisted.** The command still runs for anyone invoking it, but
  help no longer advertises it (nor do the retired `playground`/`refine`
  notices): the pre-install `npx vendo try` pitch it fronted resolves no npm
  package.

  **Init's ending puts the paste last.** The run's final line is the outstanding
  paste, on interactive and non-interactive runs alike, instead of the star ask
  or the agent tail; the "start your dev server — the agent is live in your app"
  line is withheld while a paste is still pending (it contradicted the frame
  right above it); and the keyless Cloud pitch is three lines, since `vendo
login` narrates its own ceremony.

  **Quieter dev-server logs.** The hosted-store automations notice is latched per
  process — a Next dev server recomposes on nearly every request, and the
  paragraph was landing in the host's log dozens of times per session.

- 89b2455: Add tour mode: deterministic scripted responses in front of the live agent.

  Every company that adopts Vendo has to demo it — to its own executives, to a
  prospect, to a new user on day one — and a live agent is the wrong thing to put
  in front of an audience. It is slow, it is different every time, and the one
  run that matters is the run where it improvises. So every host builds the same
  cache by hand, badly. This is that cache, supported.

  `createVendo({ tours })` takes an ordered list of `{ prompt, respond }`
  entries. `respond` is prose, a recorded app document, or a sequence of both,
  replayed at a live turn's cadence. Everything a tour does not own — every
  improvised question, every follow-up about what is on screen — reaches the real
  agent untouched.

  Two rules keep a tour from swallowing the demo it carries. An entry fires only
  on a close variant of its own frozen prompt: matching is a normalized
  similarity score over token sets and edit distance, not keyword presence, so a
  typo still lands the entry while a different ask about the same subject does
  not. And an entry fires at most once per thread, reconstructed from the
  thread's own transcript rather than stored, so it survives the live turns in
  between. Both rules exist because keyword matching cannot tell "ask for this"
  from "change the thing you just made" — it replayed the recording on top of the
  app the audience had just watched arrive, pin and all.

  An app part is a real app: the recorded document is imported as an owned copy,
  so it opens, pins, survives a reload, and can be edited by the next turn, which
  is the live agent's. Pacing is measured against real turns and drawn from a
  stream seeded by the entry's own prompt — uneven like a live provider, and the
  same unevenness on every rehearsal. Nothing in a tour calls `Math.random`.

  Plain OSS config with no Cloud dependency and no key-conditional branch: a tour
  behaves identically with and without `VENDO_API_KEY`. A host that configures no
  tours composes no seam at all.

  `@vendoai/agent` gains the scripted-turn seam this rides on: an optional
  `scripted` hook consulted after the thread resolves and before any model work.
  It lives there because everything a scripted turn must share with a live one
  lives there — the resolved thread, the persistence, the response contract — and
  a seam in the wire route could only approximate all three. The umbrella owns
  what a play is, because matching and replay need the apps runtime.

### Patch Changes

- e56ed30: Cloud-audit small fixes: five places where the runtime and what it claims had
  drifted apart.

  **The hosted session sweep now rides the authenticated tick.** Both existing
  cadences are unreachable on a serverless host — the unref'd interval timer
  never fires, and the amortized on-request sweep is gated by a per-process
  `lastSweepAt` that a per-request process re-seeds every invocation. A
  deployment on the hosted store leaked idle anonymous sessions forever.
  `POST /api/vendo/tick` now runs the same sweep the other two cadences call
  (hosted stores only; a local composition already has both). Two cadences
  firing at once is safe — the claim leg is a single-winner election
  server-side.

  **`E2B_API_KEY` without the `e2b` package is now a loud misconfig.**
  `createVendo` used to silently demote a half-configured BYO sandbox to Cloud,
  or to the dark venue with no key at all, so the operator found out at the
  first server-app build. It now throws with the exact fix. An explicitly
  passed `sandbox:` adapter still wins before any env check.

  **`fn:` steps deferred to Cloud now warn.** Enabling an automation whose
  schedule or external trigger fires on Cloud, with `fn:` steps in it, warns
  once naming the app: `fn:` runs in the app's own sandbox machine, which the
  Cloud runner may not be able to wake or reach in v1. The docs claimed this
  warning existed and described `fn:` as a callback into the host process —
  both wrong, both fixed.

  **Two honesty fixes to operator copy.** `vendo doctor` no longer offers a
  "managed MCP broker" no code path wires from a key; it names the adapter slots
  a key actually defaults. And the hosted-session-doors warning no longer blames
  a vendo-web commit for a surface the console restored on 2026-07-20 — it
  reports what the client observed (a bare 404) instead.

- ed1940a: The theme extractor now resolves `next/font` CSS variables on hosts without a
  resolvable `typescript`. The standard Next.js pattern — `--font-sans:
var(--font-inter)` in CSS, `Inter({ variable: "--font-inter" })` in the root
  layout — is read through a real TypeScript program, and `typescript` is an
  optional resolution: a JS-only Next app, a strict pnpm tree, or an npx-run CLI
  simply doesn't have one. When it was missing, every next/font derivation went
  dark at once and `vendo init` fell all the way through to "No host evidence for
  fontFamily — neutral defaults used" on an app whose font was sitting right
  there in its layout.

  Without a compiler the extractor now text-scans the layout's next/font and
  geist loader calls for the family each CSS variable names. The scan reports
  those fonts as un-applied, because text cannot prove a font reaches the markup:
  every derivation that needs that proof still fails closed to the model pass,
  and only var() resolution — where the host's own CSS is the authority on what
  the body font is — gains an answer. `next/font/local` stays unresolvable by
  design; its loader declares a variable but no family name.

- Updated dependencies [e56ed30]
- Updated dependencies [dd73974]
- Updated dependencies [ea3cb0b]
- Updated dependencies [37ec12a]
- Updated dependencies [923cf59]
- Updated dependencies [89b2455]
- Updated dependencies [bcf8699]
- Updated dependencies [8f5a7c0]
  - @vendoai/automations@0.7.0
  - @vendoai/ui@0.7.0
  - @vendoai/telemetry@0.3.3
  - @vendoai/agent@0.7.0
  - @vendoai/core@0.7.0
  - @vendoai/actions@0.7.0
  - @vendoai/apps@0.7.0
  - @vendoai/guard@0.7.0
  - @vendoai/knowledge@0.7.0
  - @vendoai/mcp@0.7.0
  - @vendoai/store@0.7.0

## 0.6.1

### Patch Changes

- 35e7431: The plain-http anonymous-session cookie is now `Path=/`, matching the secure
  `__Host-` form (#693). The cold-load race fix has hosts mint the pointer on
  their document response, mint-unless-present — but a `Path=/api/vendo` cookie
  never rides a document/page request, so on plain-http localhost such a host
  re-minted on every page load and status poll, overwriting the cookie's one jar
  slot and moving the visitor onto a fresh `anonymous_<id>` subject: list
  endpoints answered `[]` and the second message on any thread failed with
  `threadId is already in use`. https was never affected because `__Host-`
  requires `Path=/`. Existing `Path=/api/vendo` cookies keep working — the wire
  reads the pointer by name and honors it as-is.
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

- Updated dependencies [a2bd192]
  - @vendoai/apps@0.6.1
  - @vendoai/automations@0.6.1
  - @vendoai/core@0.6.1
  - @vendoai/store@0.6.1
  - @vendoai/agent@0.6.1
  - @vendoai/actions@0.6.1
  - @vendoai/guard@0.6.1
  - @vendoai/ui@0.6.1
  - @vendoai/mcp@0.6.1
  - @vendoai/knowledge@0.6.1

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

- 020fc8e: Add the judgment channel: a judge pass, an independent skeptic, and the human
  gate on loosenings (`packages/vendo/src/cli/judge/`).

  `runJudgmentPass()` reads the deterministic `.vendo/tools.json`, asks a model to
  grade it, then asks a SECOND independent run to tear that answer apart, and
  writes only what survives into `.vendo/judgments.json`. Not yet wired into
  `init`/`sync`/`try` — that is the next change; this one adds the module and its
  tests.

  The shape follows from one failure mode: a single model pass allowed to grade
  capability will confidently justify a grade the code does not support, in either
  direction. An over-tight grade silently breaks a working product; a loose one
  hands out capability. So:

  - the JUDGE proposes, and every proposal costs a VERBATIM quote from the
    handler. No quote, no proposal — rejected at parse and counted in the
    narrative, never discarded silently. One bad proposal cannot fail a whole
    batch of twenty.
  - the SKEPTIC is a second run (fresh conversation, same engine) whose only job
    is to check each field against the real source, including whether the quoted
    evidence appears in the file at all. It rejects hardenings as readily as
    loosenings.
  - anything the skeptic never examined gets exactly ONE re-ask and is then
    REJECTED, with an honest count. Unexamined never means applied. A proposal
    whose every field is rejected writes no entry at all, so a discredited quote
    is never recorded as provenance.
  - survivors route through the direction rule in `@vendoai/actions`: hardenings
    and prose apply themselves; loosenings either aggregate into ONE review diff
    (`loosenings: "review"`) or park as `pending` (`loosenings: "queue"`).

  Risk may now move in BOTH directions and a wake-up (`disabled: false`) may be
  proposed for a scanner-disabled tool — the old clamp could only refuse those,
  so a real finding evaporated into a log line.

  The engine ladder merges the two that existed (enrichment's resolver and init's
  selection) into one: the credential gate runs first so a keyless repo never
  probes a harness, an `--engine` pin never falls back to another provider, and
  availability is swept across the whole ladder so the unavailable-pin message can
  name the real alternatives. Keyless degrades to one calm line
  (`judgment: structural-only …`) with zero errors.

  Every model-originated string and every evidence snippet is treated as untrusted
  repo content and stripped of C0/C1/DEL control characters before it reaches a
  terminal — including the review diff, which is exactly what an attacker would
  want to spoof.

  Also dedupes `askYesNo`: the copy in `cli/extract/extraction.ts` is removed in
  favor of the existing one in `cli/shared.ts` (which additionally guards against
  blocking on a non-TTY stdin). Importers updated; no call-site behavior change
  for interactive runs.

- a9aa714: Wire the judgment channel into `init`, `sync` and `try`, and delete the three AI
  systems it replaces.

  `init` and `sync` now run `runJudgmentPass` instead of the staged AI extraction
  and the sync enrichment pass. The difference that matters is WHERE model output
  lands and what it costs to get there: a proposal needs a verbatim source quote,
  an independent skeptic checks it against the real handler, hardenings and prose
  apply themselves into `.vendo/judgments.json`, and loosenings — lower risk, wider
  audience, a woken tool, a cleared critical mark — wait for a human. So
  `overrides.json` goes back to meaning only "what a person decided", and a
  re-sync can no longer clobber either file.

  Deleted outright: the staged extraction pipeline (survey → draft-per-surface →
  cross-check) with its prompts, `runAiExtraction`/`applyDraft` and the whole
  `cli/enrich/` pass (watermark diff, restrictive-only clamp, tripwire), and the
  `vendo extract --apply` delegation path — including the `aiPolish` contract the
  `init --agent` plan used to carry, which no external agent can honour now that a
  judgment requires quoted evidence. `vendo extract` exits as an unknown command.

  The prose half survives as two focused stages, `runBriefStage` and
  `runThemeStage`; the brief prompt now reads the JUDGED catalog rather than a
  draft. `vendo try`'s background deepening runs judgment → brief → seeds and
  queues loosenings instead of prompting, since that surface is non-interactive by
  design.

  Flags: `vendo sync --no-watermark` is renamed `--no-ai` (the old name keeps
  working as a silent alias); `--review` now shows the queued and new loosenings;
  `--full` judges the whole catalog instead of only what moved.

  Also fixed: `vendo doctor`'s live-surface check and the `try` profile's tool
  summaries hand-rolled a tools+overrides merge that would have disagreed with the
  runtime once judgments existed. Both now resolve the same three layers the
  runtime does — skeleton ⊕ judgments ⊕ overrides — so a disable either surface
  reports is one the agent actually sees.

### Patch Changes

- db1915e: Teach the judge three labeling rules the mutation test cannot derive.

  The risk section of the judge prompt now states, alongside the mutation test:

  - **A catch-all route is graded at its worst operation.** When one URL fronts
    many operations (`[...nextauth]`, `[trpc]`, an upload or OAuth SDK handler),
    which method reaches which operation is decided inside the dependency, not in
    the host's source — so the tool is graded at the most dangerous operation
    reachable behind that URL, and when the source cannot settle it, at the worst
    plausible one, said out loud in the reason.
  - **`destructive` needs bulk or irreversible loss.** A hard delete of one easily
    re-created row or object — remove a member, cancel an invite, remove an image
    — is a `write`. If every delete were destructive the top grade would mean
    nothing.
  - **An unrecallable outbound effect is a `write` with no row written** — mail or
    SMS sent, a webhook delivered, a payment captured, an external checkout or
    billing-portal session created.

  Doctrine is unchanged: hardenings still apply immediately, loosenings still need
  the skeptic and a human, and the self-consistency check still drops a grade that
  contradicts its own reason.

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

- 23cdb00: Onboarding safety and honesty: four fixes to the first `vendo init`.

  - **A secret written into a committed file now says so.** `vendo login` and
    `vendo init --cloud-key` land `VENDO_API_KEY` in `.env.local`, and now say one
    line about whether git will commit it, with the remediation that actually
    works: `git rm --cached` when the file is already tracked (where .gitignore
    cannot help), the .gitignore line when it is untracked and unignored, and an
    explicit "git could not answer" when a live repo errors. Symlinks are resolved
    first, so a gitignored `.env.local` pointing at a tracked file is judged by
    the file the write really lands in. Silent when the file is ignored, and when
    there is no working tree or no git at all. The write is never blocked — the
    key is already minted.
  - **The closing line stopped guessing in both directions.** It claimed "the
    agent is live in your app" whenever a rung resolved — including a malformed
    `VENDO_API_KEY` or `VENDO_DEV_CREDENTIAL=vendo-cloud` with no key, neither of
    which can serve a turn. Now: a usable credential says live; a composition
    scaffolded this run with no key says "live once you add a model key"; and a
    re-run over a composition Vendo did not write states the condition, because
    that composition may pass its own `model` and nothing here can see it.
  - **A pages-only Next host gets instructions that work.** The manual wiring
    paste and the agent tail named `app/layout.tsx`, a file such a host does not
    have. They now name `pages/_app.tsx` and wrap `<Component {...pageProps} />`
    (the generated `vendo/vendo-root.tsx` is a client component, so it mounts
    there unchanged). Where the API route segment is scaffolded is unchanged.
  - **An interactive init at a monorepo root names the real host.** Detection
    finds no `next`/`express` at a workspace root and falls through to the
    runtime-neutral `custom` scaffold — silently one level too high. It now names
    the workspace packages that do look like hosts ("did you mean apps/web?") and
    suggests a path that resolves from the caller's own cwd, single-quoted when the
    shell would otherwise mangle it. Non-interactive runs already errored with the
    exact flag; unchanged.

- e4d674b: The two first-hour model failures now show their fix instead of a generic error.

  A keyless app and a missing provider install already had exact instructions —
  but the model ladder threw them as plain `Error`s, so the wire's safe-error gate
  replaced them with "An error occurred while generating the response." in the
  thread and "the turn returned an error frame" in `vendo doctor`. The honest
  message only ever reached the server log. Both are `VendoError`s now, so the
  existing rail carries them to the thread banner and doctor's live-turn line.

  A rejected key (401) got the same generic line. The ladder knows which rung it
  resolved, so it now says which key was refused and what to do: a Cloud key is
  re-minted with `vendo login`, a BYO provider key is checked in `.env.local` —
  neither is ever sent the other's next step. The provider's own error stays on
  `cause`, so its request id still reaches the server log. A 401 the ladder cannot
  attribute — a provider the host wired itself, or a tool's own HTTP failure —
  keeps the generic line rather than guessing it was about the model key. A 401
  carrying the Cloud meter refusal still renders the pricing sentence.

  `npx vendo try` turns ride that same rail now: the surface is handed the
  ladder's own model instead of the raw provider one, so a rejected key names the
  rung it was rejected on there too. That lazy model also forwards the resolved
  provider's `supportedUrls`, so a remote image or PDF the provider can ingest
  natively is no longer downloaded first — which is what made such a turn fail
  outright under restricted egress.

- 2f0a421: `vendo init --yes` no longer blocks on the loosening review, and three CLI help
  and error lines now say what the code actually does.

  `--yes` promises every question is already answered. It kept that promise for
  the AI-polish consent and broke it one step later: with `--ai-polish` granting
  consent, a run in a terminal reached the aggregated loosening review and waited
  for a human the moment the judgment pass proposed waking a disabled tool or
  lowering a risk grade — so `vendo init --yes --ai-polish` could hang in CI or
  under an agent. Unattended runs now queue loosenings instead: held as `pending`,
  nothing applied, printed with `vendo sync --review`. Auto-applying was never an
  option — risk is not lowered without a human — and no `confirm` seam is handed
  to the pass at all when the run is unattended, so nothing downstream can block
  either.

  `--yes` claimed only "skip the cloud-login offer". It also accepts the detected
  auth preset, skips the AI polish pass and the theme review, and swaps the
  interactive success screen for the agent tail — an agent reading the old line
  could not predict any of that. `--framework` listed `next, express` while
  `custom` (the runtime-neutral scaffold for Workers, Bun, Deno, Hono, and Lambda
  adapters) has been accepted all along.

  When `vendo login` dies on a transient failure — network, DNS, a killed fetch —
  it printed the raw error and nothing else, so the reader assumed the ceremony
  was lost and started over, abandoning an approval that would still have landed.
  It now names the surviving pairing code and says that re-running `vendo login`
  resumes the same request. The line appears only when a resume can actually
  succeed: every terminal outcome already deletes the claim.

- c52629b: Remix is experimental: unresolved remixable slots now warn (`experimental:` prefix, slot + reason + fix hint) instead of failing `vendo sync` with exit 2. Slots are still never skipped silently; acknowledge intentionally uncapturable ones in `overrides.json` → `remix.ignoreSlots`.
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

- Updated dependencies [89153f8]
- Updated dependencies [3ae3d13]
- Updated dependencies [127aa29]
- Updated dependencies [b14b209]
- Updated dependencies [9532dc0]
- Updated dependencies [e4d674b]
- Updated dependencies [d6c231e]
- Updated dependencies [5987985]
- Updated dependencies [a7199db]
  - @vendoai/core@0.6.0
  - @vendoai/actions@0.6.0
  - @vendoai/apps@0.6.0
  - @vendoai/ui@0.6.0
  - @vendoai/agent@0.6.0
  - @vendoai/automations@0.6.0
  - @vendoai/guard@0.6.0
  - @vendoai/knowledge@0.6.0
  - @vendoai/mcp@0.6.0
  - @vendoai/store@0.6.0

## 0.5.0

### Minor Changes

- c7277f6: Knowledge verifier pass: where the evidence score provably cannot decide, a cheap model does.

  Calibration against the cloud engine found that answerable and unanswerable questions score in the same range, so at the best possible bar 47% of unanswerable questions still got a confident answer. `@vendoai/knowledge` now exports `entailmentVerifier`: a capped, schema-constrained check that reads the passages a search returned and decides whether they can answer the question at all. An unsupported verdict becomes the existing `insufficient-evidence` outcome, carrying the gap the verifier named so the agent can say WHAT the docs do not cover.

  **It is not score-gated.** It reads every search that returns hits. An earlier design ran it only inside a calibrated score band; the live run showed four unanswerable questions per pass scoring outside that band, never being checked, and being answered — so a check gated on the number it exists to replace inherits that number's blind spots.

  **What it is measured to do.** Live against the cloud engine over the 94-question corpus: false answers 7/34 and 10/34 on its two passes, false refusals 3/60, reading 94/94 searches at 1.37-1.39 model calls per search and adding p50 ~2.5s of verification to a verified turn (summed over that turn's calls; one call's median is ~1.7-1.8s). It reduces confident wrong answers sharply — the same corpus loses 19/34 with the check gated to a score band — but it does not eliminate them, because it cannot refuse when a verification times out and it is sometimes simply wrong. The per-question records and the full table, including the removed gated configuration, are in `docs/eval/KNOWLEDGE.md`.

  **OFF by default.** `VENDO_KNOWLEDGE_VERIFY=on` opts in for the Cloud engine; a value that is neither on nor off throws at composition rather than silently disabling a trust feature. It ships off because the measurement says it does not clear the zero-false-answer bar it exists for, while costing a model call per search and seconds on a call the user waits through — that trade is the host's to make, not a default. Only the Cloud engine composes it; BYO and self-hosted engines are untouched.

  **Enabling the check changes no threshold.** The host's `weakScoreThreshold` (default 0) is exactly what it was, and it still decides every search the check could not read. When there is a verdict the verdict decides, in both directions.

  **It fails open, and says so.** No model, a timeout, or an unusable response yields no verdict: the tool answers the way it would have without a verifier and marks the result with the additive `unverified` field on `vendo/knowledge-result@1`. The thread renders that as the amber "I couldn't check this answer against the documentation" line beside the sources, so a check that did not run is never mistaken for one that passed. Verification is capped per TURN as well as per call, so a chat→deep escalation cannot spend the cap twice.

  An empty or placeholder gap ("", "n/a", "none") fails the verdict schema, so a verdict with its evidence torn off yields no verdict at all and the tool falls open marked, rather than refusing a user with a reason that says nothing.

  The verifier rides its own `knowledgeVerifier` model slot (`VENDO_MODEL_KNOWLEDGE_VERIFIER`, `models.knowledgeVerifier`) beside `judge` — pinning the model that grades answers no longer repoints the one that gates them.

  `@vendoai/knowledge` now declares `ai` as a peer dependency (with the zod floor every ai peer needs), matching `@vendoai/guard`.

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

- f95feb7: Runtime/generation wave: `apps.pipeline` threading through createVendo, `agent.instructions` host-voice seam, per-instance judge model binding (bindVendoModelSlots — the process-level slot registry is gone; `Judge.model` is now part of the guard's Judge contract), island-scoped repair + concurrent tier-0 paint lane with a monotonic partial gate, region-parallel assembly compiling the production inline-reference dialect, smoke-render environment failures skipping instead of failing apps, no-emoji contract rules, and per-lane generation logging (onTiming/onPipeline wired to the operator console).
- d1364b6: Chrome wave: split-view workspace with morphing stage, compact embeds, staged blur, stage pinning (host onPin seam), AutomationCard, ConnectCard lifecycle states, landing composer, docked new-reply banner, streaming skeletons, WorkingRibbon, connect-dock resilience, ApprovalSheet fixes, approvals-decided resume event, and eventOutcomeLabel stream-part semantics.
- b94ac5a: The vendo model family lands in the runtime. `vendoModel(name?)` replaces `devModel()` (kept as a deprecated alias): a lazily-resolving AI-SDK model bound to the credential ladder that passes any name string VERBATIM to the resolved rung — the Cloud gateway with `VENDO_API_KEY` (where `vendo`, `vendo-paint`, `vendo-judge`, `vendo-extract` are real model ids), or your provider untouched on a BYO key. There is no client-side name mapping; unknown names surface the provider's own error. `createVendo` gains a `models` block (`{ agent?, paint?, judge? }`, string or LanguageModel per slot) superseding the deprecated top-level `model` and `paint.model` (`paint.disabled` stays the single-lane switch). Per-slot env pins `VENDO_MODEL`, `VENDO_MODEL_PAINT`, `VENDO_MODEL_JUDGE`, and `VENDO_MODEL_EXTRACT` override with no code change (precedence: explicit model object → env pin → models string → per-rung default); the old `VENDO_DEV_*_MODEL` / `VENDO_CLOUD_MODEL` / `VENDO_EXTRACTION_MODEL` vars keep working as deprecated fallbacks. When no model is configured, the paint lane rides the family fast pick per rung (`vendo-paint` on Cloud, e.g. `claude-haiku-4-5` on an Anthropic key) instead of needing a `paint` knob. `vendo doctor` now states the winning model credential rung and any active `VENDO_MODEL_*` pins.

### Patch Changes

- 221b851: Vendo Cloud meter refusals (pricing v3 §5: HTTP 402, stable code
  `meter-exhausted`, structured body) now surface honestly everywhere the OSS
  client can meet them — with no client-side entitlement checks; the refusal
  body stays the only source of truth. Core gains `parseMeterExhausted` /
  `formatMeterExhausted` / `meterExhaustedFromError`: one crafted sentence
  naming the meter, the usage figures and reset date, and the two exits
  (upgrade / BYO). The Cloud adapters (hosted store, sandbox, connections,
  apps) render that sentence on their existing 402 → cloud-required mapping
  with the structured fields preserved on `detail`; the agent recognizes the
  gateway's 402 refusal on the safe stream-error rail so the thread banner
  ends the turn with it; the CLI prints the same single line instead of a raw
  error dump, and doctor's existing live-turn check surfaces safe
  Vendo-prefixed error frames verbatim. Scheduler-refused automation runs
  already read back as failed runs — the blocked reason and code now have
  test-pinned rendering in run history.
- Updated dependencies [0b58e3e]
- Updated dependencies [0e3bc0a]
- Updated dependencies [f965d77]
- Updated dependencies [cbffc9e]
- Updated dependencies [22601e3]
- Updated dependencies [c7277f6]
- Updated dependencies [da9d4a9]
- Updated dependencies [f5fbb4b]
- Updated dependencies [221b851]
- Updated dependencies [f95feb7]
- Updated dependencies [b1ba2ec]
- Updated dependencies [f49b1de]
- Updated dependencies [d1364b6]
- Updated dependencies [280a142]
  - @vendoai/apps@0.5.0
  - @vendoai/core@0.5.0
  - @vendoai/store@0.5.0
  - @vendoai/knowledge@0.5.0
  - @vendoai/agent@0.5.0
  - @vendoai/ui@0.5.0
  - @vendoai/actions@0.5.0
  - @vendoai/mcp@0.5.0
  - @vendoai/guard@0.5.0
  - @vendoai/automations@0.5.0

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
- Updated dependencies [9f01a92]
  - @vendoai/apps@0.4.8
  - @vendoai/automations@0.4.8
  - @vendoai/core@0.4.8
  - @vendoai/store@0.4.8
  - @vendoai/agent@0.4.8
  - @vendoai/actions@0.4.8
  - @vendoai/guard@0.4.8
  - @vendoai/ui@0.4.8
  - @vendoai/mcp@0.4.8

## 0.4.7

### Patch Changes

- bb74239: The wire's `open?pending=1` disambiguation now works on hosted (Vendo Cloud) store deployments and passes terminal build failures through to every caller (0.4.6 E2E cert defect D2). The existence probe behind the flag read through `appStore()` — raw SQL over a local db handle — which a hosted wire-door store doesn't have, so on Cloud-store deployments it answered false on every call and every owner-scoped not-found masked to `{"kind":"pending"}`: the #532 terminal failure records never resolved a non-owner poll, and the principal-mismatch diagnosis was unreachable. The probe now reads through the store adapter interface (every store shape serves it), and when the record carries the server-written `buildFailed` marker the wire answers `{"kind":"failed"}` with the persisted reason — a terminal failure is terminal for every caller. A genuinely absent record keeps answering `pending`.
- Updated dependencies [fd9260d]
  - @vendoai/apps@0.4.7
  - @vendoai/ui@0.4.7
  - @vendoai/automations@0.4.7
  - @vendoai/core@0.4.7
  - @vendoai/store@0.4.7
  - @vendoai/agent@0.4.7
  - @vendoai/actions@0.4.7
  - @vendoai/guard@0.4.7
  - @vendoai/mcp@0.4.7

## 0.4.6

### Patch Changes

- Updated dependencies [60c5e39]
  - @vendoai/apps@0.4.6
  - @vendoai/ui@0.4.6
  - @vendoai/automations@0.4.6
  - @vendoai/core@0.4.6
  - @vendoai/store@0.4.6
  - @vendoai/agent@0.4.6
  - @vendoai/actions@0.4.6
  - @vendoai/guard@0.4.6
  - @vendoai/mcp@0.4.6

## 0.4.5

### Patch Changes

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
- Updated dependencies [87eadba]
  - @vendoai/core@0.4.5
  - @vendoai/agent@0.4.5
  - @vendoai/apps@0.4.5
  - @vendoai/ui@0.4.5
  - @vendoai/actions@0.4.5
  - @vendoai/automations@0.4.5
  - @vendoai/guard@0.4.5
  - @vendoai/mcp@0.4.5
  - @vendoai/store@0.4.5

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
- 0c1fca2: `vendo init --framework custom`: a runtime-neutral wiring for any
  Web-standard host (Cloudflare Workers, Bun, Deno, Hono). The generated
  vendo/server.ts is a lazy Request→Response module with the environment
  passed per call; with a Vendo Cloud key it wires the Cloud adapters
  explicitly (model = stock Anthropic provider at the console gateway).
  Unknown-framework detection lands here instead of guessing the Next
  layout into hosts that aren't Next.
- Updated dependencies [52c72c2]
- Updated dependencies [835d17a]
- Updated dependencies [70b59db]
- Updated dependencies [89e3d2b]
  - @vendoai/actions@0.4.4
  - @vendoai/core@0.4.4
  - @vendoai/apps@0.4.4
  - @vendoai/automations@0.4.4
  - @vendoai/store@0.4.4
  - @vendoai/telemetry@0.3.2
  - @vendoai/agent@0.4.4
  - @vendoai/ui@0.4.4
  - @vendoai/guard@0.4.4
  - @vendoai/mcp@0.4.4

## 0.4.3

### Patch Changes

- 7355eed: Install-funnel fixes from the 0.4.x E2E certification (Wave 2):

  - **Visible surface (B3).** `vendo init` now generates a `"use client"` mount
    wrapper (`vendo/vendo-root.tsx`) that applies the registry + theme and
    mounts `<VendoOverlay />`, and wires it into the Next.js layout with one
    bounded, idempotent edit (skipped when a Vendo mount already exists;
    degraded to printed paste lines when the layout has no single unambiguous
    `{children}`). The wrapper is the RSC-safe home for the registry import —
    the previously printed registry-in-server-layout paste crashed every page.
    `VendoOverlay` is re-exported from `@vendoai/vendo/react` so the scaffold
    resolves under pnpm strict linking.
  - **Principal alignment (B4).** The anonymous scaffold's wire principal now
    resolves the same demo subject the existing-agents quickstart chat routes
    set (`demo-user`) instead of `null`, so apps and approvals created through
    a BYO agent loop are visible to the embeds. `GET /apps/:id/open?pending=1`
    now distinguishes a record that exists under another principal (terminal
    `{kind:"failed"}` with the mismatch diagnosis) from a still-building app
    (`{kind:"pending"}`) — no more infinite skeleton.
  - **Doctor honesty.** New E-WIRE-006 check fails when no visible surface is
    mounted anywhere; new E-LIVE-006 render gate GETs the app root and fails on
    a 5xx; new E-DEP-002 fails when the running wire's `/status` version
    disagrees with the CLI's (split-brain installs where a direct
    `@vendoai/vendo` pin beats the `vendoai` umbrella); E-WIRE-004 now accepts
    a `<VendoRoot>` mount in ANY app layout (not just the root one); the
    unreachable-`/status` copy names the wire base `--url` expects; the probe
    dev-server's pipes are destroyed on stop so doctor's exit code always
    lands.
  - **Login write-preflight (M4).** `vendo login` proves `.env.local` is
    writable before opening (or resuming) a claim — a sandboxed run that cannot
    write the file fails up front instead of consuming the single-use claim and
    losing the minted key — and a redemption-time write failure now reads as a
    distinct write error (revoke + retry) instead of the timeout copy.

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

- Updated dependencies [a48b1b7]
  - @vendoai/apps@0.4.3
  - @vendoai/ui@0.4.3
  - @vendoai/automations@0.4.3
  - @vendoai/core@0.4.3
  - @vendoai/store@0.4.3
  - @vendoai/agent@0.4.3
  - @vendoai/actions@0.4.3
  - @vendoai/guard@0.4.3
  - @vendoai/mcp@0.4.3

## 0.4.2

### Patch Changes

- 8eaceb5: Login and first-turn fixes from the 0.4.1 E2E certification campaign:
  `vendo login` pending claims are now scoped per project directory —
  concurrent logins in different repos can no longer clobber or resume each
  other's ceremonies (the machine-global file could deliver one project's key
  to another). A matching pre-0.4.2 claim file is migrated automatically.
  `vendo init` now installs the model provider its resolved credential loads
  at runtime (`ai@^6` plus `@ai-sdk/anthropic@^3` / `@ai-sdk/openai@^3` /
  `@ai-sdk/google@^3`), so the first turn no longer 500s on a fresh install
  until the provider is added by hand.
  - @vendoai/core@0.4.2
  - @vendoai/store@0.4.2
  - @vendoai/agent@0.4.2
  - @vendoai/actions@0.4.2
  - @vendoai/guard@0.4.2
  - @vendoai/apps@0.4.2
  - @vendoai/automations@0.4.2
  - @vendoai/ui@0.4.2
  - @vendoai/mcp@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [b7a860f]
  - @vendoai/core@0.4.1
  - @vendoai/telemetry@0.3.1
  - @vendoai/actions@0.4.1
  - @vendoai/agent@0.4.1
  - @vendoai/apps@0.4.1
  - @vendoai/automations@0.4.1
  - @vendoai/guard@0.4.1
  - @vendoai/mcp@0.4.1
  - @vendoai/store@0.4.1
  - @vendoai/ui@0.4.1

## 0.4.0

### Minor Changes

- 5d89564: Extract registered host-component catalogs deterministically during sync, persist strict catalog artifacts and stale-safe review-only copy proposals, and load generated catalogs into the umbrella runtime with actionable malformed-file warnings. TypeScript is loaded only on the sync scan path and is no longer a production dependency of `@vendoai/actions`.
- 4b8ac66: Per-user connected accounts via the Composio broker (ENG-262). Connectors gain a subject-scoped `connections` capability (list/initiate/status/disconnect); the umbrella serves per-principal `/connections` endpoints with a Vendo Cloud broker seam behind `VENDO_API_KEY`; a Composio call missing a connection returns the new typed `connect-required` tool outcome, rendered by `VendoThread` as an inline connect card that retries after connecting; `ConnectedAccountsPanel` (list + disconnect) joins the chrome as the accounts tab. Composio tools carry curated risk (metadata hints + slug patterns) instead of a blanket `write`; the MCP connector accepts an async per-principal `headers` resolver with per-subject sessions; every connector execution is audited with its account identity.
- 2f67c65: Server-actions extractor behind the extractor seam (ENG-248): statically scan `"use server"` modules and inline functions with the TypeScript compiler API, interpret zod-validated and annotated inputs into JSON Schema (fail-closed to permissive + note otherwise), and emit the additive `server-action` binding kind (`module` + `exportName` + ordered `params`) within `vendo/tools@1`. Execution is direct in-process registration: `vendo init` now generates a `vendo-actions.ts` registration map wired into `createVendo({ serverActions })`; a server-action tool whose registration is missing fails closed with a clear error and no work performed. Risk labels fail closed — actions default `write`, the destructive word list applies, and unclassifiable or inline (non-importable) actions are emitted `disabled: true` with a note.
- ebc72e4: Runtime tool search and loadout (ENG-252). Add a deterministic `ActionsRegistry.search` query API (plus the pure `searchToolDescriptors`) that ranks the merged, enabled tool surface by intent, excluding disabled tools. The agent gains a `vendo_tools_search` meta-tool: it starts from a bounded initial loadout — the whole enabled surface when it fits the cap, an explicit curated list when provided, otherwise a read-first bounded default (`DEFAULT_MAX_INITIAL_TOOLS`) — and discovers and loads the rest mid-run. Loaded tools persist across turns within a thread and execute through the same guard-bound registry as any initially-enabled tool, so there is no unguarded path. The umbrella wires the search seam to the guard-bound registry.
- b29f65d: Init AI unification: theme extraction's model fallback now rides the same consent-gated AI pass as tool judgment (one consent covers both), running through the dev's `claude` CLI on PATH or a resolvable Agent SDK — nothing installed in the host app. The exact CSS pass still always writes `theme.json` first; `--theme slot=value` overrides any slot directly. Font-family names are canonicalized without optional CSS quotes.
- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.

### Patch Changes

- b6def0f: Capture capability misses from embedded agent runs in a local JSONL sink and,
  when a Cloud API key and telemetry consent are present, upload them in bounded
  best-effort batches with the canonical enabled-tool surface.
- fbe4a49: Vendo Cloud gateway calls now send curated model aliases instead of raw provider ids. The `VENDO_API_KEY` dev-mode rung requests `vendo-default` (Sonnet) by default; `VENDO_CLOUD_MODEL` picks `vendo-fast` (Haiku) or `vendo-strong` (Opus). The box's Cloud inference rung pins `vendo-default` the same way (`VENDO_INFERENCE_MODEL` still overrides). The gateway remaps any non-alias to `vendo-default` (with an `x-vendo-model-remapped` warning header) during a grace window and will reject non-aliases after it. BYO provider keys are unaffected and keep real model ids.
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

- 51f3fc9: Fix (ENG-353): heartbeat-armed idle-abort fallback for client disconnects the runtime never surfaces. Under `next dev` a real browser's graceful tab-close/navigate-away fires neither `request.signal` nor a stream cancel, so an abandoned turn ran to completion and burned provider tokens. The panel now beats `POST /threads/:id/heartbeat` while a turn streams; the first beat arms a server-side idle watchdog that aborts the turn through the same controller as the fast path after ~15s of silence. The fetch-abort fast path is unchanged, and consumers that never beat (curl/scripted clients) keep exact run-to-completion semantics.
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
- Updated dependencies [5d89564]
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [a7d57b7]
- Updated dependencies [e9c538c]
- Updated dependencies [da4d3e8]
- Updated dependencies [a2ca8e2]
- Updated dependencies [b819ab2]
- Updated dependencies [75cb256]
- Updated dependencies [5093682]
- Updated dependencies [083a3b9]
- Updated dependencies [c42d41a]
- Updated dependencies [2f67c65]
- Updated dependencies [023b3c0]
- Updated dependencies [ebc72e4]
- Updated dependencies [fa0ad98]
- Updated dependencies [0e94fa6]
- Updated dependencies [0f17f39]
- Updated dependencies [7826a6e]
- Updated dependencies [7546de1]
- Updated dependencies [51f3fc9]
- Updated dependencies [0d2810b]
- Updated dependencies [dab84c2]
- Updated dependencies [ff6b5d5]
- Updated dependencies [8d5423d]
- Updated dependencies [0c10661]
  - @vendoai/core@0.4.0
  - @vendoai/store@0.4.0
  - @vendoai/mcp@0.4.0
  - @vendoai/actions@0.4.0
  - @vendoai/agent@0.4.0
  - @vendoai/automations@0.4.0
  - @vendoai/guard@0.4.0
  - @vendoai/ui@0.4.0
  - @vendoai/apps@0.4.0
