# @vendoai/store

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

- 6bc5cc8: One tenant brings its own tools, and only that tenant's users get them.

  A customer with its own MCP server or OpenAPI spec had one way in: you add the
  connector to `createVendo({ connectors })` and redeploy — and then every tenant
  on the deployment has it, because there was only ever one tool registry.

  `vendo.tenantConnectors` is the dev-side API that ends that. `register` takes an
  org, an MCP URL or an OpenAPI spec, and the token the customer pasted; it
  validates by ACTUALLY CONNECTING and answers with the tools the server really
  advertised, or a typed error. `list`, `test` and `remove` are the rest of the
  admin screen you were going to build anyway. There is no Vendo-hosted UI here,
  and no console step: the surface is yours.

  Visibility follows the orgs your host already asserts (`memberships`), and it is
  STRUCTURAL. A run that asserts `acme` is served the shared registry plus Acme's
  own; a run that asserts `globex` is served a registry Acme's connector was never
  in. There is no filter over a combined set, so there is no filter to get wrong.

  Registrations ride the generic records collection — no store schema change, no
  migration — stamped with the org that owns them, so the existing erase cascade
  reaches them like every other row that names a subject. The pasted token never
  lands in a row: it is vaulted in the store's encrypted secrets under a
  tenant-scoped name, and no public surface reads it back.

  The erase cascade learned one new thing to make that whole. `vendo_secrets` sat
  outside every selector for a stated reason — its rows were name-keyed HOST
  config, which no subject could reach — and a tenant connector's vault name
  breaks that premise by carrying the org that owns it. So erasing an org now
  takes its connector tokens with its registrations, and nothing else: a
  deployment's own `API_TOKEN` still belongs to the deployment, not to any person.
  One name builder in `@vendoai/core` serves both the write side and the sweep, so
  they cannot drift.

  `vendo doctor` gains `E-TENANT-001`: a host whose source reaches
  `vendo.tenantConnectors` with no `VENDO_STORE_ENCRYPTION_KEY` and no
  `VENDO_API_KEY` is warned that a pasted token is stored in the clear locally and
  refused outright in production — a failure that would otherwise only appear on
  the first credentialed registration after a deploy. Static, like every other
  doctor check: a source marker and two env names, no store opened and no tenant
  server dialled.

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

- 650e5eb: A store that asks for a table gets one. Vendo Cloud's typed data plane answers
  the first write to an undeclared table with `409 {error: "schema-proposal",
proposal}` — the DDL that would make the write legal — and the SDK could not
  read it: the body's `error` is a string, the wire envelope requires an object,
  so the parse failed, the bare status took over, and the caller got "conflict —
  store wire request failed with HTTP 409" with the server's proposal erased. Every
  app's first row write to a new collection failed, on Cloud, with nothing in the
  error to say why.

  The store client now declares what it can read on every request
  (`x-vendo-store-capabilities: schema-proposal`, scoped to store traffic — no
  other wire grows a header), confirms a proposal on the mount's schema door and
  replays the write under the SAME idempotency key, so one logical mutation stays
  one. It loops for the multi-step case (create_table, then add_column) and stops
  after three rounds; a proposal on an operation that names no app is never
  confirmed against a guessed one. Both readings of a store failure recognize the
  proposal, so the StoreAdapter façade — the surface an app's own writes take —
  heals exactly like the op client.

  Independently: `parseStoreWireError` stops discarding bodies it cannot parse. An
  unrecognized error body now rides a bounded snippet in the message, and a schema
  proposal reads as the new `schema-proposal` error code with the proposal intact
  on `detail` — so the next protocol skew is diagnosable from the error alone
  instead of from a live repro.

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

- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [1fb1810]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
  - @vendoai/core@0.27.1
  - @vendoai/apps@0.27.1

## 0.27.0

### Minor Changes

- c50597f: **Breaking.** An automation is a first-class principal-owned RECORD, not an app with a list of triggers. `AppDocument.triggers` is deleted, every automation verb keys off one automation id, and stored automations are NOT migrated — they stop firing at the upgrade and have to be authored again.

  **Tell your users before you deploy this.** Their existing automations lived inside `AppDocument.triggers`; nothing reads that field any more, and nothing converts one into a record. They re-create them (`agent.on(...)` in your code, or by asking in chat). Their run history goes too: `vendo_runs` is emptied once, because an app-keyed run row has no read path and no erase selector left to reach it.

  ## What breaks in your code

  **`@vendoai/core`.** `AppDocument.triggers` is gone, and these exports with it: `Trigger`, `triggerSchema`, `RunModel`, `runModelSchema`, `DEFAULT_TRIGGER_ID`, `TRIGGER_ID_PATTERN`, `triggerKindRefKey`, `TRIGGER_KIND_REF_KEYS`, `TRIGGER_KIND_REF_PRESENT` and `triggerKindRefs`. An app now holds at most `automations?: AutomationId[]` — a list of NAMES the apps layer maintains and resolves on read, not a foreign key, so dead ids simply drop out and there is no cascade to run. Writing `triggers` into an app document arms nothing. New in `automation.ts`: `AutomationRecord`, `When` and the one `toTriggerSource` converter, `AutomationTask`, `Budget`, `automationHash` and `reconcileAutomations`. `TriggerRef.id` is `TriggerRef.automationId`, and `PermissionGrant.triggerId` / `MintGrantInput.triggerId` are `automationId` — a record has no app id for the old pair's other half to name.

  **`vendo.automations`.** `enable` / `disable` / `dryRun` take ONE id instead of `(appId, triggerId)`. `list({ owner?, agent? }, ctx)` returns plain redacted `AutomationRecord[]`, deployment-wide. There is **no `app` filter** and there will not be one: a record carries no app reference at all, so an app page filters by resolving its own `automations` list and dropping the dead ids. `runs.list` filters on `{ automationId, owner, agent, status, cursor }`, and `RunRecord.appId`/`.triggerId` become `.automationId` plus `.owner` and an optional `.agent` — one ledger, with the owner, agent and console views as filters over it rather than tables of their own.

  **`createAutomations` config.** `apps`, `runner`, `appAccess` (and the `AppAccessSeam` type), `localTriggerKinds` and `AutomationsEngine.onDocumentEdit` are gone; so is the `triggerKey` export. `@vendoai/automations` depends on `@vendoai/core` alone now — a goal run reaches a brain through the named runner map the umbrella registers, and a task reaches an app only by naming one of that app's functions as an ordinary granted tool, which resolves through the bound registry like anything else. Delete an app and its automation still fires, then fails loudly at tool resolution with a `not-found` in the run ledger. The engine no longer watches app-document edits either: sponsorship is bound to the record's own content hash (`automationHash`), so a record whose content changed under a live sponsorship stops on its own. `@vendoai/automations` newly exports `verifySignature`, `signedWebhookBytes` and `base64url` — the one implementation of the standard-webhooks scheme, so the tick door and the per-record webhook path cannot drift.

  **`@vendoai/ui`.** `AutomationEntry` IS `AutomationRecord` (`AutomationTriggerEntry` is gone). `client.automations.{enable,disable,dryRun}` take one id; `client.runs.list` takes the new filter. `<AutomationCard>` takes `when` (a `TriggerSource`) plus an already-humanized `action` string instead of `trigger`, and `automationRule(when, action)` takes both halves — a record's task is the producer's to read, and a card that guessed at the words would put them in an automation's mouth.

  ## What breaks in your store

  Schema **v11**. `vendo_automations` is the new table: `subject` is the erase-cascade selector, because a row carries a live webhook signing key and a record that outlived its owner's erasure would be a hole rather than an untidiness; `revision` is the compare-and-swap counter every write bumps. `vendo_runs` re-keys `app_id` to `automation_id` and is **emptied once**, guarded on the old column. `vendo_grants` re-keys `trigger_id` to `automation_id`. The `trigger_kind_*` generated columns on `vendo_apps` are dropped by pattern, so the names leave the codebase entirely. The erase cascade deletes runs BEFORE automations, while the join that identifies them still exists.

  `ENGINE_ALLOWLIST_VERSION` goes 2 → 4. `vendo_automations` joins the engine allowlist; `automations:armed` and `automations:webhook` leave it — armed is a FIELD on the record, so a disarm is one write with no second row to keep in step, and the webhook secret lives on the record. If your BYO store pins the allowlist version, bump it.

### Patch Changes

- e09d69a: A Vendo Cloud rate limit now reads as a WAIT everywhere, instead of vanishing.
  The console answers 429 "Too many requests. Try again shortly." — and the OSS
  side had nowhere to put that answer. The shared console client's wire-legal
  code table omitted `unavailable`, so the console's own error code was not
  forwardable and fell to each adapter's unknown-code tail, where four of the
  five mint a PLAIN `Error`. A plain error fails `instanceof VendoError` at the
  wire, so the request logged "[vendo] unhandled wire error", answered HTTP 501
  ("this operation does not exist") and showed the person the generic "couldn't
  finish" overlay. An envelope-less 429 — the one an edge proxy sends as
  plain text — had no reading at all.

  `raiseCloudError` now forwards `unavailable` and `forbidden` as the
  VendoErrors they are, and reads a bare 429/500/502/503/504 as `unavailable`
  from the status alone, keeping the server's own sentence. 501 stays with each
  adapter's tail: "this mount does not serve the op" is not a transient failure.
  Nothing downstream changed — the wire's 503 mapping, the harness overlay and
  the store's retry were all already written against that code.

  Three places then act on it:

  - The hosted store retries a rate-limited or transiently failed call once,
    waiting the console's `Retry-After` (capped at 10s, 250ms when it asked for
    nothing) and replaying the SAME `Idempotency-Key`, so the server dedupes a
    mutation it already applied instead of applying it twice. Before, only a
    timeout was retried.
  - The batched Cloud uploader keeps a 429'd batch and sends it again, instead
    of reading every sub-500 answer as a permanent refusal and dropping it —
    which lost capability-miss and SDK-event reports exactly while an account
    was being rate-limited.
  - The per-user limiter still fails CLOSED when the meter read fails, but no
    longer tells the user they reached the host's cap when nothing was counted:
    a busy meter denies with "Vendo Cloud is busy right now, so this limit could
    not be checked — this is temporary, not a cap", on the agent's refusal and
    on the person's card alike.

  `VendoLimitPart` gains one optional field, `retryable?: true` (and its zod
  schema the matching `z.literal(true).optional()`) — additive, so an older
  consumer ignores it exactly as §15 forward-compat expects. It carries the one
  distinction the card cannot make for itself: a limit REACHED keeps the
  "You've reached your limit" headline, a limit that could not be CHECKED reads
  "Couldn't check your limit" over the same detail line. Both chokes set it —
  the message at the door and the generation mid-turn — so neither path can tell
  the person a different story than the other.

- 20aed63: `StoreOps.appData` is OPTIONAL, on the same rule the other four optional members
  already follow: a store with nowhere to keep app rows says so by OMITTING the
  family, rather than shipping a stub that accepts the call and does something
  else. A store that omits it is refused at the door onto app rows — `/box/rows`
  answers the `not-implemented` refusal it already gave a store with no
  named-operation surface at all — and the app-storage backing falls through to
  the same façade path that store already took.

  Nothing changes for the stores this repo ships: `createStoreOps` (the local
  backend) and `hostedStoreOps` (the Cloud client) both serve the family, and both
  now say so in their return type, `StoreOpsWithAppData`. The StoreOps conformance
  kit reports its appData cases as OMITTED for a mount without the family instead
  of crashing on the first verb.

- a507b92: store: heal a transiently truncated PGlite FS bundle read with one retry
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

### Minor Changes

- aa1c8db: The turn envelopes, served. The local backend answers `turn.load` by fanning out over the very ops it bundles (`transcripts.getThread`, `workspace.index`, `workspace.read`, and `harness.get`/`usage.count` when asked for), and `turn.commit` lands the batch append, the harness state and the run's audit row inside ONE `db.transaction()` — a turn that landed its messages and lost its harness state is a turn the next one resumes wrong. `/status` now reports `ops: 50`, which it may do because the two ops are genuinely served. The hosted client gains both, and they are the one family it feature-detects before sending: ONE cached `/status` read compared against `STORE_WIRE_TURN_OPS`, exactly as the batch append is detected, because this is the one shape with a cheaper fallback to route to — a mount below the level is served by the individual calls the caller always made, never by reading a failed mutation as a capability answer.

  Two prefetch seams let one `turn.load` actually replace a turn's opening reads: `workspaceStore.open` takes an `index` the caller already read (it skips the READ, never the permission filter), and `harnessStateStore.resume` is `get` for a caller that already holds the slot's row — same §1.3 rules, including a foreign harness DESTROYING the slot. `workspaceIndexPage` converts the envelope's index page into the metas `open` takes, and answers `undefined` when the page left a cursor behind, because half an index would open a turn on a workspace that is missing files.

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

### Minor Changes

- 37ed821: Per-user limits: Vendo counts, the host decides.

  `createVendo({ limits })` takes one callback, asked once before each metered
  action — a user message, an app generation — with the resolved user, the action,
  and a `count(action, window?)` reader already bound to THAT user. Return `false`,
  or `{ allow: false, message }` to say why in your own words, and the action is
  refused and never counted; anything else allows it and the meter records it.

  ```ts
  createVendo({
    limits: async ({ user, action, count }) =>
      user.facts?.plan === "pro" || (await count(action, { days: 1 })) < 20,
  });
  ```

  `count` is a callback and not a number because most policies read the meter
  once, for one window, and pre-computing every window a policy might ask about
  would be a query per action per call. `window` ANDs `days`/`hours`/`minutes`
  into one lookback, or takes a `since` instant, or names a `pool`.

  **Pools** are the shared meters a user's usage ALSO counts into — a seat pool, a
  team, an org. The auth preset grows a `pools` seam beside `facts`, resolved off
  the same session decode, and its answer rides `ctx.pools` to the policy;
  `count(action, { pool: "workspace" })` then counts the whole bucket rather than
  the one person, and an allow accrues to every pool the user is in. Counting a
  pool the user is NOT in throws rather than answering `0` — a zero from a meter
  that was never resolved silently under-counts every limit written against it.

  **A denied message costs nothing.** The message choke sits at turn entry, before
  the thread is resolved, so a refused message performs no read, no write and no
  model call. The turn's whole response is the limit card.

  **A denied generation lets the turn carry on.** The generation choke wraps
  `vendo_make`, the one door an app is built through, and answers the agent with
  the same `blocked` outcome every other refusal on that registry uses — so the
  agent can say what happened in its own words — while raising the card the person
  reads on the call's own stream.

  A refusal nobody was asked about — a limit, a guard rule, an unattended park, a
  guard that could not run its check — now settles on the wire as that typed
  `blocked` outcome rather than as the ai-SDK's `output-denied`. That state is the
  terminal state of an approval a PERSON turned down: its provider conversion takes
  the refusal's words off the part's `approval`, so a refusal that has none used to
  write history that could not be sent again, and the thread died on the turn after
  one — including an unattended thread whose call is waiting on a standing grant.
  The refusal's own words are now kept in the record too, and the beat says who
  refused: "wasn't allowed", not "you declined it". A person's actual no is
  unchanged, and is the only thing `output-denied` now means.

  Both raise `data-vendo-limit`, and the chat surface renders it as a card in the
  beat's ordinary muted register: a cap reached is not a failure, so no ✕, no
  danger colour, and a polite `status` rather than an `alert`. The host's own
  sentence is what the person reads when the policy wrote one — the host set the
  cap, so only the host can say what it is or when it lifts — and a policy that
  said nothing gets the chrome's line, which claims only that the request never
  ran.

  **A policy that throws DENIES**, and logs `limits.callback_error`. A limits
  system that fails open stops limiting silently, so the host keeps believing they
  have a cap while every user is unlimited — strictly worse than a turn that was
  refused and said so.

  **A `limits` policy against a store with no usage meter is refused at
  composition.** `StoreOps.usage` is optional, and a store that cannot count reads
  every user as zero, so no limit would ever be reached and every user would be
  unlimited. It throws where the deployment is built rather than enforcing against
  counts that are all zero.

  `vendo.usage(query)` is the operator's read of the same meter — per subject and
  action, over one window — for a host's own backend job: an overage sweep, a
  usage table. A policy never uses it; a policy asks its own bound `count` and
  never names a subject. On a meterless store it refuses for the same reason
  `emit` does, because a billing sweep reading "no usage" would bill nobody.

  Unset, `limits` wires nothing: no limiter is composed, the tool registry is the
  same object it always was, and each choke point costs one `undefined` check.

### Patch Changes

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

### Minor Changes

- 095f143: `audit.tally` — the 45th store op, and the grouped read a decision tally is.

  A reviewer's tally ("how many calls ran, were asked about, were blocked, and by
  which layer, hour by hour") is a `GROUP BY`, not a page. Reading it through
  `audit.list` means shipping every event in the window across the wire and
  counting it at the other end, which is why the console reached around StoreOps
  into raw SQL for it. Now it does not have to.

  ```ts
  const rows = await store.ops.audit.tally({
    from: startOfDay, // inclusive, REQUIRED, and the whole window
    kind: "tool-call", // the same four filters audit.list narrows on
  });
  // [{ bucket: "2026-08-14T09:00:00.000Z", outcome: "ok", decidedBy: "grant", count: 12 }, …]
  ```

  - **The same WHERE as the feed.** `kind`, `venue`, `outcome` and `decidedBy`,
    ANDed, now named once as `AuditFilters` and shared by both audit reads on the
    contract, on the wire and inside each backend. A tally that narrows
    differently from the feed it sits next to is a number nobody can reconcile.
  - **`from` is required and there is no `to`.** A tally has no cursor, so the
    floor is the only thing bounding the answer, and a caller who cannot leave it
    out cannot ask a mount to group an append-only drawer's whole history. Every
    tally is "since"; an upper bound is grammar no consumer has asked for and stays
    addable later.
  - **Fixed UTC-hour buckets, no bucket grammar.** `bucket` is the instant the
    hour starts rather than an hour-of-day number, because a number only
    identifies a bucket inside one day and the window is whatever `from` makes it.
    Hours holding nothing are omitted; rows sort by bucket, then outcome, then
    decidedBy, with an absent dimension last.
  - **Rows are typed with `AuditEvent`'s own fields.** `outcome` and `decidedBy`
    are the event's enums or `null` — a control event is not a call and has no
    outcome, and null is a group of its own. No second copy of either enum.

  Served by the local engine (one `GROUP BY`), by the memory reference, and by the
  hosted client, with conformance cases both backends run. `/audit/tally` is
  declared LAST in `STORE_WIRE_PATHS`, after `/status`: `ops` is a monotone level
  over that order, and appending is the only edit to it that cannot re-date a
  number a shipped mount already reports. No pre-send capability constant — a new
  path answers its own enveloped 501.

- 7fcf60b: The StoreOps conformance kit stops being a sequential kit, and six places where
  the three implementations disagreed are closed. A second implementation of the
  contract can no longer pass the suite while being wrong about concurrency,
  tenancy, or the batch append.

  **Races.** Every atomic op in the contract was proven by two calls in sequence,
  and a sequence cannot see the window a concurrent caller lands in: a
  read-then-write with no atomicity underneath passes every sequential case ever
  written and loses one of two simultaneous writers in production. `engine.claim`,
  `engine.insertIfAbsent`, `engine.compareAndSwap`, `workspace.commit`'s
  compare-and-swap and a double-fired idempotency key are now fired at one instant
  with `Promise.all`. Nothing asserts which caller won — either winning is
  correct — only that exactly one did and that the row the store kept is the row
  that winner was handed. The double-fire asserts what the contract actually
  promises and no more: `IdempotencyLedger` guarantees REPLAY protection, not
  mutual exclusion, so two concurrent requests carrying one key may both execute;
  what may not happen is a third request, after the key has an answer, applying
  anything.

  **Tenancy.** `StoreOpsConformanceOptions.makeNeighbour` is a second handle on
  the same physical store bound to a different tenant. Supply it and one case
  proves records, blobs, app rows, threads, secrets and workspace files stay
  apart in both directions, and that one tenant's `lifecycle.erase` cannot reach
  the other's. A single-tenant store leaves it off and the case reports as
  OMITTED, never as a pass.

  **Omissions are counted.** `ConformanceCase.run` may now resolve to
  `{ omitted: reason }`, and `ConformanceReport` gains an `omitted` bucket, so
  `passed + pending + omitted + failures === cases`. The cases over the two
  optional members (`transcripts.appendMessages`, `retention`) used to `return`
  early on a mount that omitted them, which the report counted as a PASS — "this
  mount has no batch append" and "this mount's batch append is correct" were the
  same green line, and a whole family could be dropped invisibly.

  Two consequences of that landing alongside the retention engine: the memory
  reference now serves every op the manifest declares, so its `status()` reports
  `Object.keys(STORE_WIRE_PATHS).length` rather than a literal that goes stale the
  day an op is added; and its `lifecycle.erase` sweeps quarantined rows on BOTH
  legs, matching the subject and app id the local backend copies onto every lifted
  row. Without that second one a retention lift is a way for data to outlive an
  erasure — the reference would have disagreed with the only shipped engine on the
  one cascade nobody gets to re-run.

  **`transcripts.appendMessages`** gains cases for batch ordering after the tail,
  edit-by-id in place without moving the message, the refusals (an empty batch,
  two messages under one id), the thread it creates when the id is new, and a
  revision that moves on every batch including an edit. The memory reference now
  serves the op (and reports op level 36) so the kit has a complete reference to
  run them against.

  **Untested branches now covered:** `engine.claim`'s no-replacement delete form,
  `engine.list`'s ref filter (exact containment, ANDed), `appData.list`
  pagination with the owner scope re-applied on every page, `appData`'s
  per-appId isolation, blob namespace isolation on every verb,
  `lifecycle.erase({ appId })`, the `$vendoWorkspaceBytes` envelope round-tripping
  untouched, and the commit conflict's `detail.conflicts`.

  **Divergences closed**, each because two of three implementations already
  agreed and the third was the outlier:

  - `transcripts.getThread`'s `cursor`/`limit` are **removed** from the contract,
    the wire schema and the cloud client. They arrived by pattern-cloning the list
    ops, were implemented by nobody, and were marshalled blind by the client — a
    caller that passed `{ limit: 50 }` got the whole transcript back and no way to
    notice. They cannot be implemented as declared either: the answer is one
    `VendoRecord`, which has nowhere to carry a next-page cursor, so a windowed
    read could never say there is more. Paging a transcript needs an op whose
    answer has room for one. `.passthrough()` means a client still sending them is
    read, not refused.
  - **Zero-byte blobs** are content, not absence. The wire's `bytes` field
    required a non-empty base64 string, so an empty file was refused by the client
    while both local implementations stored it happily — and the caller's `get`
    then answered null exactly as it would for a key nobody wrote.
  - **`workspace.read([])` answers `{}`** and **`workspace.commit([])` is refused
    as `validation`**, everywhere. Reading nothing has exactly one answer; an
    empty commit has none (a commit id and a trail entry for a change nobody
    made, or silence), and the wire had always refused it while the local half
    accepted it.
  - **`transcripts.appendMessages([])` is refused as `validation`**, matching the
    wire. The SQL half accepted it and bumped the thread's revision — and would
    CREATE a thread — on a call that landed no messages.
  - **`VendoError.detail` crosses the wire.** The error envelope carried a code
    and a message, so every structured payload a refusal carried was readable
    locally and lost to a hosted caller: `workspace.commit`'s conflict names the
    paths that moved, and the hosted path had to re-read the whole index and
    re-derive them by hand. `detail` is optional and passed through untouched.
  - **`workspace.commit`'s idempotency ledger is scoped to the owner.** The row id
    was built from the key alone, so two owners picking the same key — which
    clients do routinely — had one owner's commit answered out of the other's
    ledger row, as a replay when the bodies matched and as a `conflict` when they
    did not. This is the rule `IdempotencyScope`'s `tenant` field already states.

  The hosted workspace's owner-defaulting divergence is **pinned, not fixed**: the
  local implementations resolve an omitted `owner` to a bound constant and the
  cloud client defers it to the mount, whose default lives in the console where
  OSS cannot see it. A new case pins what every mount owes regardless — that the
  default drawer is ONE drawer on all four verbs.

- cfd4f48: `StoreOps.retention` gets an engine. The contract declared the family last
  release and nothing served it; the local backend serves both verbs now, so
  `status().ops` reaches 44 and the two conformance cases that shipped tagged
  `pending` are ordinary cases every mount is held to.

  - `retention.quarantine(collection, olderThan)` lifts every row whose own age
    field predates the cutoff OUT of the live collection, and answers how many
    moved. Re-running it moves nothing.
  - `retention.purge(collection, quarantinedBefore)` destroys what was lifted
    before ITS cutoff — measured from the lift, not from the row's age, because
    the grace it honors starts when the row left.

  The gap between the two is the whole feature: a retention window that turns out
  to be wrong is recoverable right up until the purge, which is what a
  `DELETE ... WHERE at < ...` on the public table map could never offer. Host SQL
  on a host's own cron still works and always did.

  Schema v9 adds `vendo_quarantine`, the engine's own drawer for lifted rows — no
  caller names it and `purge` is the only way back out. It holds each row
  verbatim (`to_jsonb` of the live row, whichever table it came from), so a
  restore has everything the sweep took. The lift is one data-modifying CTE, so a
  row is never in both places and never in neither.

  A quarantined row is still its owner's data, so the sweep copies the subject and
  app id onto it and both legs of the erase cascade match them: quarantining can
  never become a way to outlive an erasure. `vendo_threads` and `vendo_apps` are
  refused (`blocked`) rather than half-swept — a thread's transcript and harness
  state and an app's whole drawer live in other tables, and lifting the row alone
  would strand them. For the same reason a sweep sees exactly what a collection's
  own door sees: `vendo_state` holds an app's state AND a live thread's harness
  continuity, and only the first is a collection anyone can name, so only the
  first is swept.

  `memoryStoreOps()` serves the family too, so the conformance kit runs the cases
  against its own reference.

### Patch Changes

- Updated dependencies [095f143]
- Updated dependencies [7fcf60b]
- Updated dependencies [cfd4f48]
  - @vendoai/core@0.20.0
  - @vendoai/apps@0.20.0

## 0.19.0

### Minor Changes

- 5f4d694: Six capabilities the StoreOps contract was missing, so nothing has to reach
  around it into raw SQL to get them.

  - `audit.list` — the audit drawer's own typed read, filtered by kind, venue,
    outcome and decidedBy, on the same keyset cursor `engine.list("vendo_audit")`
    already walks. `venue` is a column, `outcome` and `decidedBy` live inside the
    event, and no `engine.list` ref key reaches any of them.
  - `secrets.{get,set,list,delete}` — the store's vault, on the wire. Values cross
    in the clear under TLS and are encrypted at rest server-side, so no key ever
    leaves the mount; the local engine keeps the `vendo_secrets` table and the
    envelope cipher it already had.
  - `footprint()` — per-collection byte accounting, with each collection's kind
    (`storage` or `knowledge`) alongside. `bytes` is row-content size, uniform
    across collections and comparable with itself over time — deliberately not a
    relation size, because most collections share one table and a per-collection
    disk number does not exist to report.
  - `engine.list`'s `watermark` bound — the forward walk `cursor` cannot express:
    everything after a mark, oldest first, so a job that has already counted rows
    resumes where it stopped instead of re-reading from the newest. Valid only on
    fields the collection registry declares indexed (`vendo_runs.started_at`
    today), and the bound is opaque and full-precision on purpose: a mark
    round-tripped through a JS `Date` truncates to milliseconds, moves BACKWARDS,
    and re-counts a window. The answer echoes the next bound back, which is also
    how a caller detects a mount too old to have honored it — a request field, unlike
    a new op, has no 501 to protect it.
  - `retention.{quarantine,purge}` — aging rows out of a collection in two moves,
    because the gap between them is the recovery window. OPTIONAL, and no
    implementation ships one yet: the contract is frozen here and the engine that
    owns the quarantine lands next.
  - `IdempotencyLedger` — server-side only, no wire op. `createStore()` provides
    one, and implementations MUST colocate it with the mutations it gates: a
    ledger that can commit while its mutation rolls back will confidently replay
    an answer for work that never happened.

  `ENGINE_COLLECTIONS` is now derived from `ENGINE_COLLECTION_REGISTRY`, which
  carries each collection's kind and indexed fields. Same 38 names, same order; a
  second place naming them is how an allowlist rots.

### Patch Changes

- 2879e46: `STORE_WIRE_PATHS` now declares the erase door that actually exists. The manifest listed `lifecycle.erase` at `/lifecycle/erase` with a body that wrapped the scope in `{target: {...}}`, while every mount — the console included — serves `/erase` with the scope FLAT, and the hosted client sent it there by hardcoding the path rather than reading the table. The published contract therefore described a route no client calls and no service answers: anyone building a Store Wire v1 mount faithfully from `STORE_WIRE_PATHS` would never receive an erase, and would have validated the wrong body if one arrived. The manifest is now `/erase` with a flat `{subject}` / `{appId}` request schema (still exactly one of the two — a destructive call with no scope is still refused), and both hosted erase surfaces, the `StoreOps` client and the `StoreAdapter` façade, take their route from the table like the other 35 ops, so the two can no longer drift.

  No behavior changes on the wire: the client sent `POST /erase` with a flat body before this change and sends the identical request after it. Only the contract the manifest publishes changed, to match what ships.

- cb2d68e: `hostedStore` advertises guarded writes on every collection the engine actually backs with one. `records(collection).atomic` is a feature-detection signal — callers branch on its presence — and the hosted client offered it for `vendo_threads` alone, while the local engine has backed `vendo_apps` and `vendo_effects` with a revision counter since Wave 7. The wire already served both (`ops.engine.insertIfAbsent`/`compareAndSwap` delegate straight to the routed door, behind the same allowlist), so nothing was broken on the service side: hosted callers simply feature-detected `undefined` and fell back to the check-then-put those branches exist to avoid, on the two collections the service arbitrates properly. App-row lifecycle writes and schedule-fire claims lost their compare-and-swap; effect receipts lost their insert-once.

  The mirrored set is now one named constant next to `RESERVED_COLLECTIONS`, and a parity test derives the truth from the local engine's real doors — it reads the mirror's list nowhere — so the next collection to gain or lose guarded writes fails the build rather than drifting the two sides apart again.

- Updated dependencies [2879e46]
- Updated dependencies [39a1c78]
- Updated dependencies [5f4d694]
  - @vendoai/core@0.19.0
  - @vendoai/apps@0.19.0

## 0.18.0

### Minor Changes

- 88ec7e6: Appending a message to a hosted thread stops downloading the whole conversation first. The wire had no verb that carried an owner, so the client read `data.subject` off the thread record before it could write — a turn paid that read several times, and the payload grew with the conversation forever, while the SQL half had always done the same work in one statement. `transcripts.appendMessages` is the additive 36th op (body `{threadId, subject, messages, title?}`, answer `{revision, count}`, deliberately NOT the thread — echoing the transcript back would reintroduce exactly the payload the op removes), `StoreOps.appendMessages` is its optional client method, and a turn's changed messages now go out as ONE `upsertMany`. `Thread.revision` is carried from the read so persist compare-and-swaps on it instead of re-reading, and persist runs only when the row must be created — every later turn is a pure append, title and all.

  A console that predates the op is served by an explicit capability feature-detect (the `/status` op count, the wire's own discovery handshake) asked once per StoreOps handle and cached, which routes to the older getThread + putMessage path. It is a supported route chosen BEFORE the write, never a catch-and-degrade around a failed mutation (#1251), and the count is a proxy for capability only while ops are ONLY EVER ADDED — remove one while adding another and a mount reaches 36 without serving this op, which is named in the comment for whoever adds op 37.

  Every transcript writer now takes the thread row BEFORE allocating a `seq`. `seq` carries conversation order and has no unique constraint, so equal seqs make the transcript read back ordered by message id — scrambled. Two concurrent writers used to read `max(seq) + 1` from their own READ COMMITTED snapshots before anything held a lock: on real PostgreSQL 17.11, 20 rounds of each pairing collided 19–20 times out of 20. `touchThread` runs first in `appendMessages`, `putMessage` and `recordAnswer` alike, so the loser blocks on the thread row until the winner COMMITs and allocates on a snapshot that already holds its rows; `upsertMany` and `appendThreadMessages` therefore take NO caller seq, because a position computed outside the transaction cannot be made safe. One lock order everywhere also means none of these writers can deadlock against another. The race test runs all three pairings on the postgres leg — PGlite is one connection and nothing interleaves, so it can never catch this.

- 88ec7e6: The client stops re-reading, per tool call, what it already knows. `frozen({ cached: true })` serves the CHECK-TIME kill-switch read from a 10s cache, taking 3 freeze reads per tool call down to 1 (plus one on the first call of a window); the pre-execute gate is untouched and still reads the store, so a freeze landing during the judge's window still refuses the dispatch, and any fresh read — this guard's own `freeze()`/`unfreeze()` included — refreshes the cached value. The grants list now carries `refs: { subject, tool }`, so the routed door maps the ref to an indexed column and the whole-drawer page and its JS `continue` are gone; `invalidated` is unaffected, since it only ever collected same-tool grants.

  Sharing the grant read between the preview pass and the real pass was tried and reverted, on a reviewer finding reproduced first as a test: a grant revoked or expired in the gap between the two passes still authorised the tool. A rule is a decision input, but a grant IS the authority the call executes on, so the pipeline reads the grants again for the real pass — park a standing grant on a destructive tool, preview, revoke through the real store, execute, and the guard parks where it used to run. The replay read stays unshared for its own separate reason: a human's yes lands between the two passes and the single-use CAS spend belongs to the real pass.

  A workspace `commit()` is one wire call instead of one per file. It returns early when nothing is staged or removed, and the per-path remove/land passes collapse into a single `commitAll` per owner. Per-entry `expectedRevision` (the null create-only guard included) is preserved and a stale one still refuses the WHOLE commit with `conflict`, and the SQL backend keeps its per-path statements. That last requirement is also a fix: the batched commit applied its deletions before returning `conflict`, so a caller told nothing landed retried against a file that was already gone. The SQL backend now lands every write first and applies tombstones only when no swap was lost, and the façade keeps deletions staged when the commit was refused so the re-apply the conflict branch asks for still carries them. A delete has no compare-and-swap of its own to refuse it, which made an early-applied deletion unrecoverable — true for the whole life of the per-path loop that preceded `commitAll`, and pinned by a test now.

### Patch Changes

- Updated dependencies [88ec7e6]
  - @vendoai/core@0.18.0
  - @vendoai/apps@0.18.0

## 0.17.0

### Patch Changes

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

### Minor Changes

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

### Patch Changes

- bb15cda: the app-access door rides the `engine` family

  `appAccess` resolved and wrote app permissions through `store.records(collection)`
  — the generic door a HOST reaches its own rows through — so nothing in those
  calls said that `vendo_apps` and `vendo_app_grants` are Vendo's own drawers, and
  nothing could refuse a call that reached outside them. All four sites now name
  their collection to `ops.engine.*`: the app row every level resolves from, and
  the grant list, grant write and revoke behind it.

  Same collections, same verbs, same arguments, same order. `engine` reaches the
  very same routed doors `records` did, so the `ON CONFLICT (app_id, principal)`
  floor and the rest of the per-collection policy are untouched; the one statement
  added in front is the allowlist.

  No new parameter: this helper lives inside `@vendoai/store` and takes the store
  itself, so it uses the store's OWN `ops` when it carries one — the hosted store
  does, one hop shorter than its `records` façade, which is built on these very
  ops — and the family over the adapter's record doors (`engineOverAdapter`) when
  it does not, which is what a local store and every BYO adapter get.

- Updated dependencies [9e0ed9a]
- Updated dependencies [b57df06]
- Updated dependencies [b324b79]
  - @vendoai/apps@0.15.0
  - @vendoai/core@0.15.0

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

- Updated dependencies [954ad09]
  - @vendoai/core@0.14.0
  - @vendoai/apps@0.14.0

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

- Updated dependencies [395fc1e]
- Updated dependencies [031195f]
  - @vendoai/core@0.13.0
  - @vendoai/apps@0.13.0

## 0.12.0

### Patch Changes

- 0d67885: The byApp erase cascade reaches two app drawers it never could.

  Two classes of row survived the app they belonged to, permanently, and both
  were invisible for the same reason: the cascade's selectors and the writers'
  row shapes were decided in different files and never compared.

  **The ref key.** In-client approvals (`vendo_inclient_approvals`) and remix
  rejections (`vendo_remix_rejections`) wrote their app reference as
  `refs.appId`. The cascade's byApp leg matches `refs @> {"app_id": …}` — the
  spelling every other writer in the repo uses (app tokens, placements, app data,
  armed automations, sponsorships, grants). Camel-cased, the containment check
  simply never matched, so an approval to mount an app in the host page outlived
  the app it approved. Both writers now spell `app_id`, and
  `backfillAppRefKey(store)` renames the key on rows already on disk: it touches
  `refs` and nothing else, deletes nothing, and is re-runnable by construction —
  a second run reports `rowsRenamed: 0`.

  **The version log.** `vendo:app-history:<id>` holds every stored version of an
  app plus its pin-intent trail. The byApp cascade reached generic rows two ways —
  an `app:<id>:` collection prefix, or refs containment — and app history
  satisfies neither: its name uses a different prefix, and its rows carry no refs
  at all. Every version of every deleted app was still in the table. The cascade
  now names the collection directly, through core's `engineAppHistory` builder —
  the same one the write side composes it with, so the two cannot drift — and it
  sits in the shared app-scoped step, so the bySubject leg sweeps it too.

  `createInClientApprovals` and `createAppHistory` are now exported from
  `@vendoai/apps`, so `@vendoai/store` can prove the cascade against the real
  writers rather than a hand-rolled copy of the rows they produce.

- Updated dependencies [0d67885]
  - @vendoai/apps@0.12.0
  - @vendoai/core@0.12.0

## 0.11.0

### Minor Changes

- aeb1bae: `backfillAppDataStamps` — the migration that keeps pre-appData data visible.

  Every appData read is auto-scoped to the caller's owner: `refs.subject` on rows,
  an `<owner>/` leading key leg on their file twins. A row written before a door
  moved onto the family carries neither, so the moment that door flips the row
  goes **invisible** — not deleted, unreadable, and an auto-scoped query returning
  nothing looks exactly like an empty collection. This is the one-shot, re-runnable
  migration that stamps that data with the owner it always had.

  `backfillAppDataStamps(store, { batch = 500, appId })` reports
  `{ apps, rowsStamped, rowsSkipped, filesMoved, orphanCollections }`. The owner is
  `vendo_apps.subject` with no personal-vs-promoted branch — a promoted app's
  subject IS the org id (§9.5), so the row already holds the right value. Only
  rows lacking a stamp are touched, so a second run reports `rowsStamped: 0`;
  `data`, `revision` and `updated_at` are left exactly as they were, because the
  row's content did not change and a bumped revision would fail a live CAS holder
  for a change it cannot see.

  **Where an owner cannot be established — or cannot be used safely — nothing is
  guessed at.** A collection whose app has no `vendo_apps` row, whose app row
  carries an empty subject, or whose subject contains the `/` that separates the
  owner leg from the caller's file key, is REPORTED in `orphanCollections` and
  left completely untouched. That last one is data, not policy: owner `own_a/sub`
  with key `x.bin` and owner `own_a` with key `sub/x.bin` spell the identical
  stored key, and no later validation can unbend a key already written. The
  function issues no `DELETE` anywhere, and a blob key collision throws rather
  than inventing a resolution.

  `lifecycle.promote` now moves the whole app in its existing single transaction:
  the app's appData is backfilled _before_ the row flip (so the stamp it writes is
  still the old subject), then every row and file changes hands in one uniform
  rename, and the app's bearer token's `refs.subject` follows. Both halves are
  required — rows alone would leave a promoted app's box writes stamping the
  departed personal subject, and the org blind to its own new data.

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

- 5c8043d: `appData` fences the owner, so a path-like subject can no longer read another
  user's files.

  The owner is the first path segment of every appData file key (`<owner>/<key>`),
  and nothing checked it. `appId` was fenced against `":"` and `collection`
  against `APP_DATA_COLLECTION_PATTERN`; the owner went in raw. So owner
  `own_a/sub` reading `x.bin` read owner `own_a`'s file `sub/x.bin` — a silent
  cross-user read for any host whose subject ids contain a slash, which
  `org/user`, an email-derived id, or a URI-style OIDC subject all can.

  `APP_DATA_OWNER_PATTERN` (`/^[^/]+$/`) is now enforced at the wire schema and at
  the store composer, on every one of the eight verbs, with the `validation` code.
  Deliberately **not** a slug grammar: a subject is the host's own user id in the
  host's own spelling, so `auth0|64f…`, `user:with:colons` and
  `person@example.com` all still pass. Only `/` is refused — and it is refused,
  never rewritten, because a sanitised owner would land two different people in
  one drawer.

- 5c8043d: `appData.put` decides the owner conflict in ONE statement, so an absent-row race
  can no longer destroy a foreign owner's data.

  `put` read then wrote: `insertIfAbsent`, then `SELECT … FOR UPDATE`, then an
  unconditional upsert. `FOR UPDATE` locks **nothing** when it returns no row, so
  a holder who deleted the id after the insert lost and before the select ran left
  the composer looking at an absent row — and the upsert then overwrote and
  re-stamped whichever owner had taken the id in the meantime, silently destroying
  a row that owner could still neither read nor delete. The existing `conflict`
  refusal closed the common case and not this one.

  The put is now a single owner-predicated upsert: `ON CONFLICT … DO UPDATE …
WHERE refs @> <owner stamp>`, which takes the conflicting row's lock before it
  evaluates its predicate, so a foreign holder makes the statement touch no rows
  and the caller gets `conflict`. Absent, or already ours, still succeeds. No
  application-level locking, no widened transaction, no schema change.

  Proven on real Postgres with a second connection churning the id at the
  composer's statement boundaries (`packages/store/tests/app-data-put-race.test.ts`);
  PGlite is single-connection and cannot express the interleave.

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
