# @vendoai/core

## 0.36.2

## 0.36.1

## 0.36.0

### Minor Changes

- 0108715: A remix follows the page it was forked from. The `<Remixable>` wrapper now
  couriers its wrapped instance's live serializable props to the server — on mount
  and again on every change — and the ported screen is painted on them.

  Until now it was painted on the baseline's `sampleProps`, captured the day
  `vendo sync` ran. Maple's remixed net-worth card read `$54,907.15` — the
  hardcoded declared example in the host's own registry — while the host's card two
  inches away read `$142,929.30`, with a visibly different chart series. A port
  renders FROM its props and a query resolves before the render, so nothing in the
  screen's source could ever have carried them; the capture was the only value the
  floor had.

  `AppSeed.props` records them, `POST /apps/:id/props` (`apps.seed.props`,
  `client.apps.courierProps`) is the door, and the checks floor's props resolver
  prefers them over the capture — which remains the fallback for a remix whose
  wrapper has not couriered yet. Writing props is provenance about the call site,
  not a content edit: it mints no version and replays no wish, so it is safe on
  every render the props really change on.

  The boundary is the captured baseline's own declared prop names, applied at the
  door, so a prop the host component never declared is dropped before it is stored.
  JSON-serializable values only, as before.

  Also removes the client-side splice this replaces. It searched the payload for a
  node named `seedComponentName(slot)` with `source: "generated"`; a remix is a
  ported SCREEN whose tree is whatever rendering produced — nodes marked
  `source: "ported"` — and that name only ever names a seat in
  `document.components`. The find never matched and the merge never ran, which is
  why the numbers were stale in the first place.

- 2c662ac: On the sandbox rung, warming the chat now warms the machine the conversation
  actually runs on. `POST /threads/warm` — the call the panel fires when the chat
  surface opens — replays a real turn under a throwaway thread id, and the box
  pool keyed on that id: so every warm call booted a real cloud box the user's
  first message could never find, paid a full cold boot anyway, and left the warm
  box idling its whole billed TTL before being destroyed unused. Warming cost a
  box and bought nothing but the provider's prompt cache.

  A warm turn's box is now parked as a warm SPARE, and the first real
  conversation claims it: re-keyed to its own thread, liveness-probed on the way
  in, and handed over exactly as a fresh box is — the workspace is materialized
  and the session opened for that conversation, so nothing of the probe's turn
  carries into the user's first message. A spare that died in the meantime falls
  back to a cold boot, a second warm reuses the live spare instead of booting a
  second box, and a spare nobody ever claims is reaped on the same idle budget as
  any other box.

  Each box now says how it was obtained, so the saving is greppable rather than
  inferred: `harnesses.claude-code-box-ready` reports `thread-reuse`,
  `spare-claim` or `cold-boot`, with the time it took.

  `WARM_THREAD_PREFIX` is new in `@vendoai/core` — the thread-id prefix a warm
  turn carries. It is what the pool reads to recognise one, since `Harness` is
  deliberately unchanged: a warm turn is an ordinary turn, and the id is the
  whole of the seam.

### Patch Changes

- 0b6bb92: A remix's wish list records what the person GOT, and a follow-up edit changes the
  port instead of replacing it.

  One follow-up ask on Maple was refused three times and left four entries on
  `seed.wishes` — a list every Update replays in order, so one ask became four
  edits the person never made. The front door recorded the ask whether or not the
  change landed, which is right for `memory.asks` (the next editor wants to read
  "asked for X, then asked for X again, narrower") and wrong for the replay list
  beside it. `AppsRuntime.remember` now takes `landed`, and only a change that
  reached the screen becomes a wish. The ask itself is still recorded either way,
  the list is still ordered and never trimmed, and an inapplicable wish still lands
  on `seed.unapplied` and is still said out loud.

  The fourth attempt then abandoned the ported source and rewrote the app out of
  the host's catalog, losing the first wish's edit. The port reaches the model
  through `startingSource`, which was filled from the CHECKOUT — and the checkout
  only ever fills an EMPTY workspace. So once the first edit's save had landed a
  file, every later edit of that remix arrived with no code at all in front of it
  (the loop has no file hand and cannot read the workspace itself), and an ask with
  nothing to change is answered out of the catalog. The stored screen is now read
  for every edit of a remix, not only the first; it is still never written over a
  file a save left behind. A port that genuinely cannot take an edit now fails
  through the one channel there is, rather than succeeding as a different app.

## 0.35.0

## 0.34.0

### Minor Changes

- f7e0ff4: An outside agent can put the user's files at the MCP door, and read them back.

  The door used to withhold `vendo_user_files_list` and `vendo_user_files_read`
  from every external client. That fence is gone: an outside agent connects AS the
  user, and reaching the files that user shared is the point of connecting. The
  isolation that matters was never per-door — it is per-USER, and it is
  structural, because every hand opens the workspace for the caller's own
  principal and there is no subject argument to get wrong.

  `vendo_user_files_put` is the third hand: one file, by name, into the caller's
  own drawer, replacing anything already saved under that name. Text rides in
  `content` as-is; anything else rides base64 with `encoding: "base64"`, because a
  tool call is JSON and JSON has no bytes. It honours the SAME
  `createVendo({ uploadMaxBytes })` cap as the drop door and refuses in the same
  sentence — one cap, named in one place, so a file refused in chat cannot be
  admitted by asking over MCP instead.

  Reading back a file that is not text is now an honest answer instead of a blank
  one. A parquet, a database file or anything else still STORES, and the read says
  so: that the file is saved, that its contents cannot be read back yet, and
  exactly which types do come back as text — so an agent can ask the user for a
  CSV rather than narrate an empty result.

## 0.33.0

### Minor Changes

- 8c7b476: Vendo runs on both AI SDK majors. The peer range widens from `ai >=6 <7` to
  `ai >=6 <8`, and the three things that made an `ai@7` host fail are gone: the
  turn loop and the generation engine send their cacheable system block as
  `system` instead of as a system-role message inside `messages` (ai@7 refuses the
  latter with `AI_InvalidPromptError`, and both majors carry the same message form
  — cache breakpoint and all — to the provider unchanged), and the spec-version
  gates on provider failover and the screen agent's per-role seat now admit the
  v4 spec that ai@7-era providers report instead of only v3.

  `vendo doctor` follows: `ai@6` and `ai@7` both pass, a pre-v6 install still
  fails on the peer floor, and E-DEP-001's ceiling moves to majors above the
  supported pair. `vendo init` stops telling an `ai@7` host to downgrade, and the
  "install your provider" line no longer names an `ai` major at all — `ai` is
  already resolved by the time anyone can read it.

  A new `ai-dual` CI lane pins the whole workspace to the ai@7 pairing and runs
  the suites against it, so a peer range that claims two majors is checked rather
  than asserted. This is the compat half of #478, whose short-term half was the
  fail-fast this replaces.

- 9d3f0af: With `VENDO_API_KEY` set and no memberships seam of your own, the SDK now
  resolves the acting user's companies from the tenant directory in Vendo Cloud,
  cached 60s per user — and everything that already reads `RunContext.memberships`
  (app sharing, the `org:<id>` limiter pool, org workspaces) starts working with
  no host code. Per-tenant caps set in the console are enforced by the limiter
  that already exists; on a store with no meter they simply do not compose, rather
  than refusing to boot. A directory outage serves the last answer, or none —
  never a failed turn.

  Caps reset on the calendar boundary in UTC, not on a rolling lookback:
  `messagesPerDay` refills at UTC midnight and `generationsPerMonth` on the first
  of the month, so a message sent at 23:59 does not spend the next day's
  allowance.

  `memberships` is now also a top-level `createVendo` key, the per-seam twin of
  `auth.memberships` for hosts on the `principal` trio — the same precedence
  `actAs` and `oauth` already have. Assert it and it wins outright: no Cloud
  client is constructed and no request ever calls out.

  That twin is also how a keyed deployment declines the directory. If you set
  `VENDO_API_KEY`, use `principal` rather than an `auth` preset, and have no
  orgs, say so once and Vendo will never ask Cloud:

  ```ts
  createVendo({
    principal: async (req) => …,
    memberships: async () => [],
  })
  ```

  Without that line, such a deployment resolves memberships from Cloud — one
  cached call per user per minute, and, until your project has tenants, a log
  line saying the directory had nothing to say.

  `TenantDirectoryPayload`, `TenantLimits`, `TenantCap` and their zod schemas are
  new in `@vendoai/core`; `cloudDirectory`, `tenantLimits` and `createLimiter` are
  new on `@vendoai/vendo/server`.

## 0.32.0

## 0.31.0

## 0.30.1

## 0.30.0

### Patch Changes

- 56c81b5: `vendo_tenant_connectors` joins the engine allowlist. The collection tenant
  connectors write their registrations to (`packages/vendo/src/tenant-connectors.ts`)
  was never added to `ENGINE_COLLECTION_REGISTRY`, so a deployment on a
  Cloud-hosted store — the posture a Cloud host gets by leaving the store slot
  unset — had its first registration refused with `collection
"vendo_tenant_connectors" is not an engine collection`, which left `register`,
  `list`, `test` and every tenant's own tools dead on a live deployment while the
  suite stayed green: every tenant-connector test composes a local store, and a
  local store has no allowlist in front of it. Exactly the miss the text channel's
  three collections shipped with. The name is added with the `file:line` comment
  each entry in that list carries, `ENGINE_ALLOWLIST_VERSION` moves 5 → 6 as that
  constant's contract requires, and a new seam test drives
  `createTenantConnectors` through `hostedStore`, `hostedStoreOps` and the fake
  console — which serves the same gate as the live door precisely so a fake cannot
  bless a collection production refuses. If your BYO store pins the allowlist
  version, bump it.

## 0.29.1

## 0.29.0

### Minor Changes

- 6bc5cc8: A file your user drops in chat is now theirs to keep. It is saved into their own
  `/user/files/`, private to them, and it is still there in next week's
  conversation — where the agent can list it, read it, and build on it. Until now
  an attachment rode one message and ended with it.

  The message that follows a drop carries only a reference to the file, which is
  what keeps a transcript light: a spreadsheet is stored once instead of being
  repeated in full on every turn of the conversation about it. Images are the
  deliberate exception and still ride inline, because that is how a model sees a
  picture at all. On the way to the model a saved file becomes a line of text
  naming it and where it landed — a provider handed a workspace path where it
  expects file data would read the path as base64 and think about garbage.

  Two read-only tools come with every deployment, no adapter and no key:
  `vendo_user_files_list` and `vendo_user_files_read`. They are on the one
  registry, so they are guarded, audited and searchable exactly like a host tool,
  with no privileged side door. Neither takes a path — only a file NAME, from
  which the path is built server-side — so there is no caller-supplied path for a
  `..` to climb out of the drawer with, and the name check that refuses separators
  and dot-segments is the same one the write doors use. A long file is read 200
  lines at a time so a spreadsheet is walked rather than cut off mid-row, and a
  file that is not text answers with its type and size instead of mojibake.

  Building an app from a file COPIES what it needs — the rows of a table become
  the app's own saved items. That copy is a snapshot, not a live link, and there
  is no watcher and no background sync anywhere in this design: when a newer
  version of the file arrives the AGENT is what notices, says the file was
  replaced, and updates what it built. Uploading the same name replaces the file,
  because re-sending a corrected export is the common case and a drawer that
  quietly accumulated four near-identical spreadsheets would serve nobody. In this
  release a PDF or an image lands in the drawer and can be described, but does not
  reach an app.

  `POST /files` is the door — the file's raw bytes under its own media type, no
  multipart, capped at 5 MiB — and `vendo.putUserFile({ principal, name, content })`
  is the same server-side write called from host code, for pushing a file at a
  user without waiting for them to bring one. It delivers nothing and starts no
  turn; the file is simply there next time they chat, and the door's cap does not
  bind it. In the browser it is one call: `client.files.upload(file)`.

  Because an upload's body is bytes rather than JSON, that door sits outside the
  wire's json-mutation CSRF floor, and the tolls the other exempt doors pay do not
  transfer: an upload's Content-Type is the file's own, and real files are
  `text/plain`, which is CORS-safelisted. So it requires a custom request header
  instead (`UPLOAD_HEADER`, sent by the client). A browser cannot set one on a
  cross-origin request without winning a preflight this wire never answers, which
  is what keeps a hostile page from pushing files into a signed-in user's drawer
  on their ambient session cookie.

  Storage is the ordinary BYO seam. Unset, files live in your store's own blobs;
  `createVendo({ files })` takes any S3-compatible bucket to raise that, `vendo
doctor` reports where a deployment's uploads land, and the boot block adds a
  `files` row when you have wired an adapter of your own.

- df0b4cb: A tool you write by hand is now three lines of typing, not a hand-built descriptor.

  The `tools:` slot has always taken a `ToolDefinition` — a descriptor plus an
  `execute` — but writing one meant authoring JSON Schema by hand beside a
  TypeScript function, and then keeping the two honest about each other forever.
  Nothing checked that they agreed. A schema that said `id` was required while the
  function read `taskId` was a tool the model could only call wrong.

  `defineTool` takes the schema once, as zod, and derives both halves from it: the
  JSON Schema the model is shown, and the parse that runs before `execute`. A call
  whose arguments the schema rejects is refused with a message naming the field,
  and the body never runs. `risk` is required and graded — you wrote the tool, so
  you know what it does; `ungraded` stays the answer only extraction is allowed to
  give.

  What comes back is a plain `ToolDefinition`, so nothing is hidden behind the
  helper: every descriptor field it does not ask for is a spread away
  (`{ ...defineTool({ … }), confirmEach: true }`), and the tool joins the one
  registry under the name it declared, guarded, audited and projected exactly like
  an extracted one.

  Schemas are read in zod 4's shape. On zod 3.25 or later that is the `zod/v4`
  import; a zod 3 schema is refused at definition time with the import that fixes
  it, rather than crashing somewhere inside schema conversion.

### Patch Changes

- ebf101a: A slow turn now says WHERE it was slow. `agent_run` carried one wall-clock
  number and a `steps` field hardcoded to `0`, so the only honest answer to "why
  did that take nine seconds" was to guess. It now carries `ttftMs` — how long
  the person waited for the first word — plus the five phase marks the wall time
  splits into (`storeMs`, `promptMs`, `modelMs`, `toolsMs`, `guardMs`), and
  `steps` is the turn's real model-call count. `durationMs` starts at the top of
  the turn rather than after the opening store reads, which is why a slow store
  used to be invisible in it. Durations and counts only: a breakdown says how
  long, never what was read, prompted, thought, called or judged.
- 7e78031: Arming an automation is ONE page and ONE yes. Live 2026-08-18 on production
  Maple: a user armed "check my checking balance every 15 minutes and text me"
  entirely over iMessage, their YES to the job landed — and arming then minted four
  MORE per-tool asks (Text me, knowledge search, request a connection, list
  connections). Three were reads nobody needs a second opinion about, and the
  fourth was literally in the sentence they had just typed. Consent was framed
  per-tool while the person was thinking per-job.

  The authoring call's own approval now NAMES what the automation will hold, and
  that one yes mints all of it. The powers ride on the approval record
  (`ApprovalRequest.powers`, additive and optional, human titles only), computed
  once at park time by the composition and rendered verbatim by whoever reads it —
  the text channel today, any other surface without further work. They are grouped
  the way a person reads them: the tools that DO something named one by one, and
  every read folded into a single trailing "Read-only access to your data", because
  naming reads individually is exactly what turned a yes to a job into a wall of
  tool names.

  What an automation is granted has NOT changed, and neither has how it runs. The
  surface is as wide as it ever was, every away call is still grant-backed, and 05
  §6's away authority is untouched — the guard's law suites pass unmodified. Two
  kinds are excluded from standing powers because a grant could never satisfy them
  and the card would be promising what the run will not honour: `destructive` and
  `ungraded` (§12's pair, now closed on the two branches that leaked — a steps
  record's declared destructive tool, and a connector slug the risk resolver grades
  destructive), and `confirmEach`, which needs a person every time.

  Minting is gated on a person having actually been asked. `enable()` takes the
  authoring call (`armedBy`); when the host's policy would have asked about it, the
  call reaching the engine proves the ask was answered, so the powers are minted on
  the spot. When policy would have run it unasked — `vendo_make` is read-graded —
  nobody saw a powers page, so nothing is minted and each power is captured as a
  pending ask exactly as before, delivered by the grant-set text.

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

- f06b033: An org the host already asserts is a usage pool, with nothing wired for it. A
  host that answers `memberships` for a request — the same assertion app grants
  are matched against — now gets one pool per org, named and keyed `org:<orgId>`
  by core's own principal encoding, so a limits policy can cap a whole team the
  day it can name one:

  ```ts
  limits: async ({ user, count }) => {
    // Guard on `user.pools`: an identity with no asserted membership — a signed-out
    // guest, an inbound text — is in no org pool, and counting one denies the turn.
    if (!user.pools?.includes("org:maple")) return true;
    return (await count("message", { days: 30, pool: "org:maple" })) < 200;
  },
  ```

  One grammar, not two: the string a policy counts is the string a grant names
  that org by. Teams stay out of it — a team is a slice of an org's allowance, not
  a bucket the host asked to meter. A pool the host asserts itself still wins on a
  name collision, so metering an org by the host's own key keeps working — override
  it for every member of that org, because half an org on `org:<orgId>` and half on
  your own key is one allowance split across two meters that each under-count. A
  policy naming an org nobody asserted still fails closed rather than reading zero.
  An inbound text asks the same seam for the linked subject — it is keyed on the
  principal, not a request — so a member who texts draws on the org's allowance
  instead of quietly outside it. Maple demonstrates it: the branch shares 200
  messages a month, on top of a per-person daily cap.

## 0.28.0

### Minor Changes

- 0143c4e: The stored `tree` leaves the app document. The model never writes layout and no
  production door mints a tree-only app — an app IS its `app.tsx`, and its tree is
  what RENDERING that produces — so the field, the branch that served it, the paint
  path gated on it and the fact checks that walked it are all deleted.

  What changes for a host: `AppDocument.tree` is gone from the type and the schema,
  and `.vendoapp` no longer carries it. A row written before this still opens — the
  field is STRIPPED on the way out of the store and on the way in, never refused —
  because such a document opens on its `source` like any other. A document with no
  usable source at all now RESOLVES as `{kind:"failed"}` with a reason naming why,
  instead of throwing and leaving an embed to poll to its deadline; importing a
  `.vendoapp` that holds a layout and no source is refused in the same words rather
  than minting a row that can never open.

  BREAKING for a host's own checks: a check that read `document.tree` reads
  `undefined` now and will never see a tree there again. The rendered tree moves
  onto `CheckInput.renderedTree`, beside `document` and `request`, where it belongs —
  it is what the person is about to see, not something a document carries — and
  every such check must move to that field.

  The tree as a RENDER language is untouched — `UIPayload`/`TreeNode`, the
  renderer, the streamed view parts, the render seam, and `ui: "tree"` as the
  surface kind all stay exactly as they were.

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

- 62c8630: The channel can text you first, and it stops talking itself out of the job.

  One sentence of hidden grounding rode on every inbound text: "you cannot send
  scheduled, recurring or unprompted texts, and you cannot set any of that up from
  here — say so plainly if asked, point to the app, and say it is coming soon." It
  was written about delivery. Next to a user's actual ask it read as a
  channel-wide restriction, and on 2026-08-18 the agent refused four separate
  transfer requests over text — "isn't something I'm able to do from here… do that
  directly in the Maple app" — without ever searching its tool catalog, on a
  prompt carrying three copies of the search-first instruction. The web surface,
  which has no such note, moves the same money without a blink. The note itself
  taught the refusal. It was also false about automations, which a texted user can
  set up perfectly well.

  The channel now states the one limit it actually has, and names the way around
  it: "To text the user later, set up an automation for it — the Text me action is
  how an automation reaches this phone, and its grant is part of arming. You cannot
  otherwise send scheduled, recurring or unprompted texts. That is this channel's
  only limit: anything else your tools can do, you can do right here in this
  conversation."

  That last clause is only true because the action it points at now exists.
  `vendo_text_me` sends one text to the person the run is FOR, from any surface — a
  web chat, an app, an automation firing at 6am while they are asleep. It composes
  exactly when the text channel does, so a deployment that never asked for texts
  is not offered a tool whose every call could only refuse.

  Its input is `{ text }` and nothing else. There is no number to pass, so no model
  output can aim a text at a phone that is not the current user's own: the
  destination is read from that subject's link row, which only exists because the
  signed-in user asked for a code and texted it back. Consent is the machinery that
  was already there — a `write` descriptor on the one registry, so a live turn
  parks whatever card the host's policy calls for, and an away firing needs the
  standing grant that arming mints. "Text me when the rent clears" is allowed once,
  on the screen where it is armed, and delivered from then on.

  Nothing is claimed that did not happen. A user with no phone linked gets a
  result carrying the connect link itself, minted fresh, so the agent can offer it
  instead of apologising; a phone the router can no longer reach gets a result that
  says the text did not go through and that reconnecting will fix it. The link row
  remembers the conversation the person's own messages arrive on, which is the only
  address the channel has — the deployment never learns the router's addressing,
  and never sends to a bare number.

## 0.27.1

### Patch Changes

- ebe9ffc: A store that will not hold one collection no longer takes the whole deployment down with it.

  0.27.0 on a Vendo Cloud key served 501 to every route. The hosted store's engine allowlist did not carry two of the collections this version reads — `vendo_automations` and `vendo_app_seen` — and the automations one is read at BOOT, by the code-automations reconcile that rides the `ready()` latch. The latch memoizes, so the first refusal became every route's answer for the life of the process: 2.3 seconds for the first request, 3 milliseconds for every one after, all of them 501, including the routes that never touch an automation.

  Three separate faults, and the deployment needed all three fixed:

  The boot reconcile is no longer the deployment. A store that refuses the automations read leaves code-authored automations off and says so once, in a line the operator can act on; everything else serves. Scoped to that one read — every per-request store failure still fails in the open, where the caller can see it.

  The unseen dot costs the dot, never the answer. `vendo_app_seen` was read on the path that LISTS a person's apps and written on every render, so a store refusing that collection took the whole page of apps with it. A refusal is absorbed there now, once per process, and the apps arrive without their arrival dots.

  And `instanceof VendoError` does not survive a realm boundary. A host bundle can carry two copies of `@vendoai/core` — the ESM `dist/` beside the CJS `dist/cjs/` — and the second copy's VendoErrors are a different class with the same shape, so every `instanceof` gate said no. That is why a blocked collection reached the wire's catch-all as an unknown fault and answered "Internal Vendo error" instead of its own 403.

  `isVendoError` is the check that survives it: `name` plus `code`, the two things any of these gates actually read. Every type-gate in the repo takes it now — 48 of them across the eight packages that had one — because the failure was never specific to the wire. The same class of error decided whether a lost compare-and-swap re-aimed or crashed the workspace façade, whether a swept approval rendered "expired" or an error card, whether a host's knowledge adapter got its code named in the operator's log, whether a permission route answered 403 or threw, and whether a build's "busy, try again shortly" read as "generation failed" — a verdict on an ask that was never the problem. `@vendoai/harnesses` proved the duck check first and kept a private copy of it; that copy is now this one function.

- 1fb1810: A timed-out approval ask settles as expired, not as the person's no. The
  APPROVAL_WAIT_MS settle used to ride the ai-SDK's `output-denied` state — whose
  meaning is "the person answered no" — so the thread narrated "you declined it"
  for a question nobody answered, and the persisted part carried nothing that
  could ever tell the difference. The settle now carries a typed outcome
  (`status: "blocked"` with `cause: "expired"` — a field on the existing member,
  not a new status, so already-published validators pass it through and older
  chrome degrades to "wasn't allowed", which at least blames no one), the beat
  reads "the approval expired unanswered", and the distinction survives reload
  because the part settles as `tool-output-available` with the outcome on it.
  The model-facing result is unchanged: the same denial naming the approval it
  still needs.
- ebe9ffc: Every block binds the host's zod. These four declared zod as a dependency only, while the other seven declared it as both a dependency and a peer of `>=3.25.0 <5` — and the peer is what makes pnpm bind the host's copy. So on a host that resolves zod 4, which `ai`'s own peer range admits, the seven bound the host's zod and the four kept their own: one package set, two zod instances. A schema built in one is not a schema in the other, so `@vendoai/core`'s `riskLabelSchema` inside `@vendoai/guard`'s `z.object` threw `Invalid element at key "risk": expected a Zod schema` and every tool call died before it started (#1314).

  The four now declare the same peer, so there is one zod for all eleven. `scripts/dependency-guard.mjs` gains rule 5 to hold the posture uniform: a published block that bundles zod must declare that exact peer range.

## 0.27.0

### Minor Changes

- c50597f: A boxed app's host-tool call asks once, and the tap runs it. `POST
/box/tools/<name>` dispatched straight at the guard-bound registry, so the
  permission card it parked was one nothing could ever resume: the customer tapped
  Allow and nothing happened, clicked again and got another card, forever — a
  layer-2 ("machine") app could not call a single host tool. The call now rides the
  same park-and-resume flow an in-app action does, and away execution accepts the
  tap itself as its authority: the consumed approval is projected into the grant
  shape the `actAs` seam takes (scoped `exact` to the arguments the person was
  shown, `source: "approval"`, never stored, never matched), exactly as the MCP
  door's OAuth consent already is. Approving runs THAT call and nothing else — no
  standing permission is minted, so each distinct call asks on its own account.
- a6ec9ba: An app now arrives somewhere a person can see it, and takes shape while they
  watch. Generated apps used to appear by surprise and load behind a generic
  shimmer: nothing said an app was new, a build in flight was a spinner with no
  information in it, and a pinned app had no handle at all.

  Arrival is a per-person flag, server-side. `AppsRuntime.seen(appId, ctx)` is the
  idempotent mark, `AppsRuntime.list` now answers `AppListRow[]` — the document
  plus an `unseen?: boolean` this caller's read alone can say — and the rows
  carry it through `VendoClient.apps.list()` to `useAttention().unseenApps`, which
  lights the launcher's quiet dot. Precedence is unchanged: a waiting decision
  still shows the numbered badge instead, and `unseenResults` now means a finished
  run OR an app nobody has looked at (the pill's spoken line names neither half).
  Rendering marks it, and only rendering to a PERSON does: `GET /apps/:id/open`
  records it, while the same runtime door an MCP client or an automation reaches
  through does not, so an agent reading a tree never clears somebody's dot. Rows
  live in `vendo_app_seen`, which puts the engine allowlist at
  `ENGINE_ALLOWLIST_VERSION` 3, and they are swept when the app is deleted.

  A build in flight is now visible instead of merely slow. `AppsRuntime.open`
  takes `{ pending?: true }` and answers `PendingSurface` with an optional `tree`
  — the forming payload's GEOMETRY, node ids and nesting and no data values — so
  the embed's existing 1.2s poll paints stepped assembly off the same request
  rather than a bar, and never shows a number it will take back. Unfinished
  sections render wet (dim, desaturated) and dry to full ink as they land, once,
  with the hairline ring following the last one. Slots remember the shape of the
  app they held and wait in its silhouette rather than a shimmer, and a placed app
  carries the ✦ handle: Edit in chat (`OpenConversationOptions.appId` features the
  app on the stage and prefills the composer), Refresh, Unpin. The pin flight
  lands flush and its confirmation ring now waits for the placement write
  (`PinCeremonyOptions.confirmed`) instead of an animation timer.

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

- c50597f: One automations engine per deployment, the brains a firing can reach named at composition, and `POST /api/vendo/tick` the only door that wakes it.

  The whole public surface:

  ```ts
  vendo.agent; // the agent this deployment adopted, read back
  createVendo({ agents: [support, billing] }); // MORE brains, resolvable by name
  vendo.automations.list / get / enable / disable;
  vendo.automations.runs.list / get / stop / rerun;
  vendo.automations.dryRun;
  ```

  `createVendo({ agents })` is registration only — nothing in that list serves chat turns. It makes a name resolvable, so a firing declared by `support.on(...)` lands on `support`. (`agent:` is the different, existing key: that one this deployment ADOPTS, taking its harness, store and instructions.) A firing's brain is looked up BY NAME at fire time and registered at BOOT, so two agents wearing one name throw during `createVendo` rather than at 2am, when the lookup would already have reached the wrong brain. A name nobody registered is a loud FAILED row in the run ledger and never a fallback brain: the wrong agent acting with the owner's grants is worse than nothing running, because nobody would ever find out.

  **There is deliberately no public `create`.** The one create operation is internal, so a host that can observe automations and switch them off still cannot mint one; `vendo_automate`, `vendo_make`'s sugar, the `vendo.json` fold-in and `agent.on` are the four doors in.

  ## The firing door

  `POST /api/vendo/tick` takes two credentials side by side, both verified against `VENDO_TICK_SECRET`:

  - `Authorization: Bearer $VENDO_TICK_SECRET` — your own cron (a Vercel cron, a GitHub Action, crontab).
  - A standard-webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`) over the EMPTY body — Vendo Cloud's heartbeat. This leg is new.

  You configure one thing and either waker works. **With `VENDO_TICK_SECRET` unset, both are refused**, Cloud's heartbeat included, so a deployment with no secret fires nothing — if you read that env var as the BYO-cron credential only, set it now. The door answers `202 {"fired":n}`, and its idempotency is the engine's own atomic cursor claim rather than anything the door asserts, so a duplicate knock claims nothing and honestly says `{"fired":0}`.

  The signed leg keys the HMAC on the DECODED secret. A standard-webhooks secret is random bytes carried as base64url text, and a door that hashed the text's own characters would have answered 401 to every signed knock forever. This one calls the engine's `verifySignature` — the same function the per-record webhook path uses — so there is one implementation of the scheme and a test cannot agree with a wrong door. A host who chose a passphrase rather than base64url still gets a working bearer and simply never matches on this leg.

  `localFiringKinds` is gone from the repo entirely: the engine decides what is due, and the tick is the only thing that asks. The boot reconcile reads the store on the `ready()` latch even with zero `.on()` declarations, because a deployment that just deleted its last one still has stragglers to disarm.

  ## core

  `toTriggerSource` tested `webhook === ""` when the hazard is the key being ABSENT. The webhook arm is the fall-through, so an object naming none of the five `When` shapes — which is what an untyped wire body is, and the admin routes are exactly that caller — walked in and left with `{ kind: "external", connector: undefined }`: an automation nothing can ever trigger, reported to its owner as armed. It is refused now, naming the shapes.

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

- bfaa06b: A texted turn authenticates its host calls. `presence: "present"` meant two things at once — "a person is here, so ask them to approve" and "forward the caller's browser credentials" — and a text message satisfies the first without the second: there is no request behind it. So a linked customer's tool call reached the host API carrying nothing, the host answered 401, and the agent apologised for a sign-in problem the person could do nothing about. `RunContext` now carries `channelLink`, the text channel's evidence that this subject authorized this phone, and the actions registry authenticates such calls through the ActAs seam — exactly as it already does for MCP-OAuth users, who have no browser session either. Presence stays `present`, because that is what lets the guard ask for approval on a money-moving call instead of refusing it outright.

## 0.26.0

### Minor Changes

- c369e14: **Breaking:** one model seat per real job — `default`, `apps`, `review`, `judge` — and the old spellings are gone rather than deprecated.

  `createVendo({ models })` now takes exactly the four jobs that run: `default` thinks (chat, compaction, subagents, automations), `apps` writes the generated apps, `review` grades the finished ones, `judge` answers the guard's run/ask/block. The old vocabulary named things nobody could act on — `fill` was the app writer, `reviewer` was read by nothing at all, and the app-writing agent silently read `default` while `paint` configured a lane that no longer existed. A seat you cannot point at a job is a seat you cannot set correctly.

  Gone, each with a boot error naming its replacement:

  - top-level `model` → `models.default`
  - top-level `paint` → `models.apps` for the model half, `apps: false` for `disabled`
  - the `fill` seat → `apps`; the `reviewer` seat → `review` (which never had a reader and now has one: the AI reviewer)
  - `devModel()` → `vendoModel()`
  - `VENDO_MODEL_PAINT` → `VENDO_MODEL_APPS`; `VENDO_MODEL_REVIEW` is new
  - the `VENDO_EXTRACTION_MODEL` fallback → `VENDO_MODEL_EXTRACT`
  - `migrateModelSeats()`, which no production path called

  Cloud gateway family ids follow the seats: `vendo`, `vendo-apps`, `vendo-review`, `vendo-judge`, `vendo-extract`. `vendo-paint` is gone, and `vendo-review` is new — so is its env pin, which the reviewer seat never had.

  Resolution is one rule stated once: an explicit seat wins; an unset seat borrows `default` — the object when you passed one, its own rung pick when `default` rode the credential ladder. On the Cloud rung each seat resolves to its own family id; on a BYO provider key the reading seats (`review`, `judge`) take the provider's fast model and the writing seats (`default`, `apps`) take its flagship. The app-writing agent now genuinely runs on the seat named after it — it read `default` before, so `models.apps` was a knob that changed nothing.

### Patch Changes

- 443edd4: Apps seeded before a remix carried its instruction load again. `appSeedSchema` made `instruction` required, so every stored `seed` written without one failed the read-side integrity check (`validateDocument`) and its app refused to open — a document that had been valid when it was written became unreadable. `instruction` now defaults to the empty string on read, so an old seed parses as the seed it always was while the field stays required for everything that writes one.

## 0.25.0

### Minor Changes

- aa1c8db: Two batched store-wire ops so one agent turn costs one call at each end instead of many. `turn.load` bundles a turn's opening reads — `transcripts.getThread`, `workspace.index`, `workspace.read`, and optionally `harness.get` and the `usage.count` a limits policy needs — and `turn.commit` bundles its closing writes: `transcripts.appendMessages`, optionally `harness.set`, and optionally the run's audit `engine.put`. Both bodies are pure composition of the per-op schemas that already existed, and every answer is exactly what the individual op returns, so nothing here is new semantics; the only thing that changes is the number of round trips. The family is OPTIONAL on `StoreOps` (`usage`'s rule) and rides the tail of `STORE_WIRE_PATHS`, so a mount that omits it reports the level it always did and a caller that finds it absent makes the calls it always made. Clients feature-detect on `/status` with the frozen `STORE_WIRE_TURN_OPS = 50`, read with `>=`, exactly as the batch append is detected.

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

### Minor Changes

- 6856b4f: A screen mounts only once its build is terminal.

  A screen saves as it goes, so its app ROW lands at the first save that paints — and the mandatory reviewer pass and its one repair round run after that. Every surface that mounts from the row stops looking the moment `open()` answers, so a person could be left in front of a draft — a wrong NUMBER included — while the server already held the corrected version, with nothing but a page reload to fix it.

  `AppDocument.building` (`@vendoai/core`, optional, server-written) is that window made durable: the first painting save of a build stamps it, and `open()` answers the same not-found the app gave a moment earlier with no row at all — which the wire's build window already turns into the `{kind:"pending"}` every embed keeps polling on. So there are no client changes: `useApp` and `VendoAppEmbed` both branch on it today, and `VendoSlot` gets "building" off the placement read. The trade is deliberate: first paint waits for the repair.

  `buildInFlight(building)` is new on `@vendoai/apps/contract`, and it is time-bounded on purpose — past the UI build deadline either the watchdog landed a terminal record or the build's process died, and a flag that never cleared would leave the app unmountable forever.

  The window is wired ONCE, around `assemble` itself, so the two doors that run an assembler cannot disagree about when a build ends, and a `finally` settles a run that threw or escalated. A harness writing `app.tsx` straight through the workspace is untouched — there is no build behind that save to be unfinished.

- 491a2fa: The whole catalog is in the prompt, so `search_components` is deleted.

  `references/format.md` now carries `catalogPrompt()` instead of `kitPrompt()`:
  one line per component — name, summary, props by class with `!` on the required
  ones, then its slots — plus the 227-name icon vocabulary no prompt has ever
  carried. Measured on this base it costs 13,313 characters against the 20,819 the
  per-brick sections cost for one fewer brick and no icons. A writer that can read
  every component it may use, and every host component by name in its brief, has
  nothing left to search for.

  Removed: the `search_components` tool and its `VENDO_TOOL_TITLES` entry,
  `VendoVerbPorts.searchComponents`, `searchRuntimeCatalog` and
  `CatalogSearchMatch` from `@vendoai/vendo`, and `ScreenSurface.hasComponents` /
  `ScreenAssemblerDeps.hasComponents` — the flag existed only to take the verb off
  the loadout for a deployment with an empty catalog. `VENDO_VERB_TOOLS` is
  `["validate", "schedule"]`.

  Also gone: `catalogThemeSummary` — but only the half of it that duplicated. It
  rendered two things. The host COMPONENT list was a second rendering of what
  `renderBriefingPack` already hands the screen agent, and that half is deleted;
  the pack is now the one and only rendering of that list. The one-line theme
  summary was never a copy of anything — the pack hands the screen agent the theme
  TOKENS verbatim, as JSON, for the rung that renders — so it stays, as
  `themeSummary`, and the `system.catalog` prompt slot is renamed `system.theme`,
  venue-gated exactly as before. A configured theme still reaches the system prompt
  as `Theme: <density> density, <motion> motion, <font> typography.`

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

- 6856b4f: The ✦ gesture collects an instruction, and mints a screen. There are no bare forks: ✦ asks what the person wants BEFORE it fires, and the fork plus that first edit are ONE operation whose output is an ordinary screen app (`app.tsx`, through the ordinary edit door) carrying the remix's provenance — component, baseline, and the instruction, verbatim.

  **Breaking, and it reaches data already on disk.** `AppSeed.instruction` is now REQUIRED (`appSeedSchema`, `@vendoai/core`). A remix seed written before this release does not have one, so its app document fails schema validation and that app will not load. There is no migration in this release. A deployment carrying remixes either backfills `seed.instruction` on those rows with the text the remix was made for, or deletes them and lets people remix again. Apps that were never remixes are untouched.

  Two doors change shape with it, both refusing a call that used to be legal:

  - `seedFrom({ component, slot?, instruction })` — `instruction` is required on `VendoClient.apps.seedFrom` (`@vendoai/ui`) and on `SeedFromInput` (`@vendoai/apps`).
  - `POST /apps/seed` (`@vendoai/vendo`) requires `instruction` in the body and answers `validation` — `instruction must be a non-empty string` — without it.

  Nothing copies the captured host source into the document any more, and nothing evaluates one: `applySeedFork`/`seededBundle` are gone from the generation engine, `seedOnto` from the seed surface, and the wire save's seeded carry-forward from `authoredDocument`. All three were internal. "Is this remix edited?" is one field read now — `doc.source["app.tsx"] !== undefined`.

  A re-seed is RE-IMAGINED rather than kept. When the host ships a new baseline, `reseed` replays the RECORDED INSTRUCTION against it instead of swapping in a pristine copy, so a remix survives its component's redesign as the thing the person asked for. Dedupe per (subject, component) is unchanged, and so is the review lane.

  Three dead ends that used to lie now tell the truth:

  - **A remix still generating is "not ready", not "broken".** Against a real model the first edit takes 9–38s; `open` answered that window with a validation failure, `useApp` spent its three retries in ~900ms, and nothing asked again — the pill sat on "Remixing…" until someone reloaded the page. A seeded app with no screen now answers the same not-found every app gives before its build lands, which the wire's existing build window turns into `{kind:"pending"}`, and `useApp` keeps asking on the embed's cadence until the screen lands or the ONE shared build deadline runs out. A genuinely tree-less app keeps its validation failure. The ✦ badge reads "Remixing…" off the open payload — the same signal the mount below waits on — so the label and the screen change together instead of the label arriving four seconds early.
  - **A fork the build gave up on says so.** A terminal `{kind:"failed"}` lands in the chrome's existing "Didn't load" state, with the server's own reason, instead of reading "Remixed" and "Sandboxed — only you see this" over a page that never got a screen.
  - **A failed remix edit never advances the baseline it did not reach.** `edit()` RETURNS `failedEdit` on its common failure path rather than throwing, and both remix doors read only the throw. A re-seed now replays BEFORE it writes the rebased `seed.baseline`, so a refused replay no longer answers 200 with the old screen and the new baseline. A failed first edit leaves the same terminal `buildFailed` marker a failed build leaves, so `open()` answers with the reason and `list()` skips the row — the next tap mints a fresh app instead of being handed the dead one forever.

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

- 39a1c78: `parseStoreWireError` no longer degrades a 429/5xx store-wire failure to
  `not-implemented`. A dropped Postgres connection under load answered a bare
  503, and the client reported "Vendo Cloud store does not support the
  transcripts.appendMessages operation" — a transient dependency failure
  misread as a missing capability. 429/500/502/503/504 now classify as the new
  `unavailable` VendoErrorCode (retryable); 400/402/403/409 are unchanged. The
  console's own `unavailable` envelope (`lib/api/respond.ts`'s
  `apiServerError`) now parses as itself too, instead of failing schema
  validation for carrying a code the enum didn't recognize.

## 0.18.0

### Minor Changes

- 88ec7e6: Appending a message to a hosted thread stops downloading the whole conversation first. The wire had no verb that carried an owner, so the client read `data.subject` off the thread record before it could write — a turn paid that read several times, and the payload grew with the conversation forever, while the SQL half had always done the same work in one statement. `transcripts.appendMessages` is the additive 36th op (body `{threadId, subject, messages, title?}`, answer `{revision, count}`, deliberately NOT the thread — echoing the transcript back would reintroduce exactly the payload the op removes), `StoreOps.appendMessages` is its optional client method, and a turn's changed messages now go out as ONE `upsertMany`. `Thread.revision` is carried from the read so persist compare-and-swaps on it instead of re-reading, and persist runs only when the row must be created — every later turn is a pure append, title and all.

  A console that predates the op is served by an explicit capability feature-detect (the `/status` op count, the wire's own discovery handshake) asked once per StoreOps handle and cached, which routes to the older getThread + putMessage path. It is a supported route chosen BEFORE the write, never a catch-and-degrade around a failed mutation (#1251), and the count is a proxy for capability only while ops are ONLY EVER ADDED — remove one while adding another and a mount reaches 36 without serving this op, which is named in the comment for whoever adds op 37.

  Every transcript writer now takes the thread row BEFORE allocating a `seq`. `seq` carries conversation order and has no unique constraint, so equal seqs make the transcript read back ordered by message id — scrambled. Two concurrent writers used to read `max(seq) + 1` from their own READ COMMITTED snapshots before anything held a lock: on real PostgreSQL 17.11, 20 rounds of each pairing collided 19–20 times out of 20. `touchThread` runs first in `appendMessages`, `putMessage` and `recordAnswer` alike, so the loser blocks on the thread row until the winner COMMITs and allocates on a snapshot that already holds its rows; `upsertMany` and `appendThreadMessages` therefore take NO caller seq, because a position computed outside the transaction cannot be made safe. One lock order everywhere also means none of these writers can deadlock against another. The race test runs all three pairings on the postgres leg — PGlite is one connection and nothing interleaves, so it can never catch this.

## 0.17.0

### Minor Changes

- c17d492: A parked press gets its answer: the approval modal, the refresh on resolution, and the animated landing.

  A guarded action pressed on a generated screen parked for approval and then
  dead-ended twice over: the ask had no UI anywhere on the page (only a badge
  count), and once someone approved it — over the wire, from the chat card — the
  action ran server-side while the screen sat on "Sending…" and stale numbers
  forever. The resumed call's outcome was simply discarded.

  Now the whole loop closes. The apps runtime persists what became of a parked
  call (`PARKED_CALL_OUTCOME_COLLECTION`, shared with the BYO lane so both write
  the same rows), `GET /approvals/:id` serves it — answering `pending` while the
  resumed call is still running, so the decide window reads as what it is — and
  the screen watches its own parked presses: on `executed` it re-reads its query
  plan and repaints backend truth; on `declined`/`expired` it re-reads too, so a
  screen whose own state latched "sending" re-arms instead of locking forever.

  The ask itself is a centered modal, mounted wherever screens mount (slot, chat
  card, workspace stage, BYO embed, remix): the ask at hero size, Approve/Deny,
  a designed in-flight state for the seconds the decision takes to run, and a
  queue so burst presses ask one question at a time. Esc closes without deciding
  — the pending notice on the pressed control is now pressable and re-raises the
  ask. `ApprovalResolution`'s pending arm may now omit `request` (the decide
  window has no ask left to show); consumers skeleton or fall back.

  Refresh repaints animate: an arriving row opens under a fading highlight, a
  leaving row collapses and returns its gap, and numeric leaves roll to their new
  figure — repaints only, never first paint, never streams, and never under
  `prefers-reduced-motion`.

### Patch Changes

- 64004b6: Arming asks become visible on every StoreAdapter. The automations arming capture wrote its approval rows to `vendo_approvals` without the `subject`/`status`/`call` refs the guard's ref-filtered feeds query by — repo-shipped stores masked it (the reserved table derives those refs from the row itself), but a generic or cloud-hosted records store honors exactly what a writer passes, so the asks were counted by `pendingGrants` yet invisible to `GET /approvals` and immune to the guard's abandoned-ask sweep: an automation card "waiting on N permissions" with nothing to decide, forever. Core now exports `approvalRecordRefs` as the one refs contract for the collection's writers; the guard's park delegates to it; the automations capture stamps it on mint, keeps it across the consume flip, and re-stamps it when arming adopts a pre-contract pending ask — so re-enabling an automation heals rows minted before the fix.
- 85fc732: The text channel's three collections join the engine allowlist. `vendo_channel_links`, `vendo_channel_asks` and `vendo_channel_events` were never added to `ENGINE_COLLECTIONS`, so a deployment on a Cloud-hosted store — the posture a Cloud host gets by leaving the store slot unset — had its first channel write refused with `collection "vendo_channel_links" is not an engine collection`, which left the link route, the status and unlink doors, and every inbound text answering 403 on a live deployment while the suite stayed green: every channel test composes a local store, and a local store has no allowlist in front of it. The names are added with the `file:line` comment each entry in that list carries, `ENGINE_ALLOWLIST_VERSION` moves to 2 as that constant's contract requires, and a new seam test drives the channel repositories through `hostedStore` and the fake console — which serves the same gate as the live door precisely so a fake cannot bless a collection production refuses.
- 8ded5cc: The automation ask stops falling into the two-step trap. The `schedule` verb's words matched its behavior nowhere: titled "Set when this runs" and described as "Set or change … what you are arming", it taught calling agents to build a view with `vendo_make` and then arm it here — but the verb only re-times an EXISTING automation, so the ask died with a refusal and no automation was ever authored (field: every scheduled-task ask on the linkwarden baseline). Now the verb says the one thing it does — retitled "Change when this runs", described as never creating, naming `vendo_make` (this app in `app`, schedule and action in one request) as the authoring door — and the no-trigger refusal carries the same exact next move so a mid-turn agent can recover. The screen agent's escalate door also names away work explicitly ("any part that must run while nobody is watching — a schedule, a product event — … escalate the WHOLE ask"), closing the gap where its skill taught the `<Server>` declaration but the door's own text listed only real-code reasons to leave, so a schedule ask got assembled as a plain view with no trigger. The MCP app shim is regenerated for the retitle.

## 0.16.0

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

## 0.12.0

## 0.11.0

### Minor Changes

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

- 0e51585: `AppMachine.envStaleAt` — the Wave-7 env-rebuild marker — and the wake-time
  rebuild it gated are removed.

  The marker's only production writer was the secrets-exposure grant flow deleted
  in #1100, so nothing could set it any more and `rebuildStaleEnv` could never
  run. What goes with it:

  - `AppMachine.envStaleAt` (`@vendoai/core`) — field and schema entry
  - `rebuildStaleEnv` and both of its wake call sites (`machine-lifecycle.ts`)
  - the `injectEnv` slot on `MachineLifecycleConfig`, whose only reader it was,
    and the `injectEnv: pushBoxEnv` wiring in `box-lane.ts`
  - `nextEnvStaleAt` (`persistence.ts`), which already had zero callers

  The two paths that assemble and inject a box's boundary env are untouched:
  provision (`buildEnv` → `SandboxAdapter.create`) and the pre-edit re-injection
  every box edit makes (`buildAppEnv` → `pushBoxEnv` over the box control port).
  `pushBoxEnv` itself stays — the edit path is its live caller.

  The machine schema is `.passthrough()`, so a stored document that still carries
  an `envStaleAt` key parses exactly as before; the key survives as an unknown
  field and is simply no longer typed, validated, or read.

- 361f9b9: The app format has one definition, and a test that fails when a mirror drifts

  The format was kept by hand in four places — the contract, core's pinned limits,
  the manual the agent reads, and the public docs — and they disagreed. The manual
  promised "16 islands, 64 KB each" and never mentioned the **256 KB total** the
  validator also enforces, so a build that obeyed the manual could exceed a budget
  it was never told about and fail to validate for a reason it could not see.
  Nothing about enforcement changed; the manual and the docs are now generated
  from, and pinned to, the same constants.

  **A generated component may now be a bundle, and nothing migrates.**
  `AppDocument.components` values widen from `string` to `ComponentEntry` —
  either the legacy bare source string or a `ComponentBundle`
  (`{ source, modules?, styles?, sampleProps?, origin: "authored" | "seeded" }`).
  Backward compatible **by construction**: a stored bare string still reads, and
  every reader goes through `bundleOf(entry)`, which returns
  `{ source, origin: "authored" }` for one. No document is rewritten, no version
  is minted, and an app stored before this release opens unchanged.

  _If you read `document.components` yourself_, that is the one change to make:

  ```ts
  // before
  const source = document.components?.[name];
  // after
  import { bundleOf, componentSources } from "@vendoai/apps/contract";
  const source = bundleOf(document.components?.[name] ?? "").source;
  const asSources = componentSources(document.components); // the whole map
  ```

  `ComponentBundle`, `componentBundleSchema`, `ComponentEntry`,
  `componentEntrySchema` and `bundleOf` are **declared in `@vendoai/core`**, beside
  the `AppDocument` field they type — core's store conformance kit parses a stored
  row with `appDocumentSchema` and cannot reach up into `@vendoai/apps`. The
  contract door **re-exports** them and never re-declares them, so
  `@vendoai/apps/contract` remains the one place to import the format from. Same
  rule as `TREE_MAX_GENERATED_COMPONENTS` / `TREE_MAX_COMPONENT_SOURCE_BYTES` /
  `TREE_MAX_TOTAL_COMPONENT_BYTES`, which are re-exported from core here too.

  **BREAKING — the plan dialect loses two leaf fields.** `PlanLeaf` no longer has
  `query` or `attrs`, and `<Leaf>` no longer parses a `query` attribute or
  collects arrangement hints. Both were parsed and fact-checked with no downstream
  consumer. A `<Leaf query="…" col="2"/>` still compiles — the extra attributes are
  simply ignored — so no plan text breaks; only code reading `leaf.query` or
  `leaf.attrs` does. The plan's top-level `<Query>` list and `<Cannot>` are
  unaffected.

  **New on `@vendoai/apps/contract`: the real validator surface.** `componentMapError`
  and `utf8ByteLength` (the generated-component map rules, measured in UTF-8 bytes),
  `SAFE_COMPONENT_NAME`, and `componentSources`. A consumer validating a component
  map should call `componentMapError` rather than re-implementing the byte
  accounting and the reserved-name check against `KIT_COMPONENT_NAMES`.

  **The Kit vocabulary is one list.** `KIT_COMPONENT_NAMES` derives from `KIT_SPECS`,
  `kitComponentNames()` returns that list instead of recomputing it, and
  `WIRE_COMPONENT_NAMES` is `KIT_WIRE_COMPONENT_NAMES` re-exported — the same
  binding, not a second array. All three names are still exported and their values
  are unchanged.

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

- e87a765: `AppDocument.server` — the retired v1 snapshot ref — is removed from the schema.
  Its last readers went with the tier-4 deletion in `@vendoai/apps`, and a
  production audit of all 84 Cloud tenant schemas and the console mirror (898 app
  documents) found zero documents carrying it, so the field dies wholly rather
  than lingering as a declaration nothing reads.

  Two validation rules move with it:

  - the fn:-presence rule no longer accepts `server` as a substitute for a box —
    its message is now `fn: references require a machine`
  - the `server` reference-format check is gone; `machine.snapshotRef` keeps the
    same `SERVER_REFERENCE_PATTERN` check it always had

  The shape schema is `.passthrough()`, so a stored document that still carries a
  `server` key parses exactly as before — the key survives as an unknown field and
  is simply no longer typed or validated. The one behavior change: a document with
  `fn:` references, a `server` and no `machine` used to validate and now does not.

- 79d7088: Three shapes the apps runtime produces and the client consumes now have exactly
  one definition, in core.

  `@vendoai/ui` may not import `@vendoai/apps` (the dependency guard's layering
  rule), so it re-declared the wire shapes it reads "verbatim from the frozen
  contract text". That is a promise, not a mechanism. `pinComponentName` — the
  generated-component name a forked host slot ships under, and therefore the name
  the client's in-place mount looks the node up by — existed as THREE hand-written
  copies: `apps/pins.ts`, ui's `<Remixable>` wrapper, and ui's wire fixture.

  Moved into `@vendoai/core`:

  - `pinComponentName` → `core/app-document.ts`, beside `Pin` (it is a pure
    function of `Pin.slot`).
  - `PlacementEntry` and `ReviewStanding` → `core/app-surfaces.ts`, a new module
    whose membership rule is one line: apps produces it, ui consumes it off the
    wire.

  No package's public surface changes. `@vendoai/apps` still exports
  `pinComponentName`, `PlacementEntry` and `ReviewStanding` from the same modules
  as before, and `@vendoai/ui` still exports `PlacementEntry` and `ReviewStanding`
  from its root — each is now a re-export of core's single definition.

  `PinForkResult` was deliberately NOT unified. Its own fields match on both
  sides, but its `edit?: EditResult` does not: apps' `EditResult` carries
  `failure`, `graduated`, `box` and `pendingEgress`, which ui's copy never grew,
  and the wire returns the runtime's result untrimmed. Unifying it would widen
  `@vendoai/ui`'s published `EditResult` — a contract change, not a refactor.

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

## 0.9.0

### Minor Changes

- 18c77cd: Vendo no longer mints a guest identity. Every wire request must resolve a
  `Principal` through the host's own `principal(req)` — there is no more
  null-means-anonymous fallback. A `createVendo` composition with no
  `principal` (and no `auth` preset, which supplies one) throws `VendoError`
  at construction time, naming the missing line. A resolver that returns
  `null` for a given request now refuses that request with `forbidden` (403)
  instead of minting an ephemeral session. Pre-1.0, hard cut, no shim.

  Removed entirely: the `vendo_sessions` table and its session registry, and
  the TTL sweep that expired idle anonymous sessions. The store wire drops
  four doors —
  `lifecycle.adopt`, `sessionRegister`, `sessionStale`, `sessionClaim` — going
  from 31 ops to 27. There is no anonymous-to-signed-in merge anymore;
  identity is whatever the host's resolver says it is, from the first
  request.

  Hosts that relied on the zero-config default (no `principal`, no `auth`)
  need one explicit line:

  ```ts
  principal: async () => ({ kind: "user", subject: "dev" });
  ```

  The `sessions` option on `createVendo` is renamed to `sweep`. What is left
  of it is the TTL cadence for parked BYO calls and stranded approvals, which
  outlived guest sessions and was never about them:

  ```ts
  // before
  sessions: { sweepIntervalMs: 60_000, ttlMs: 1_800_000 }
  // after
  sweep: { intervalMs: 60_000 }
  ```

  - `sessions` → `sweep` (`{ intervalMs?: number; now?: () => number }`)
  - `sessions.sweepIntervalMs` → `sweep.intervalMs`
  - `sessions.ttlMs` → **removed, no replacement.** It was the idle-guest-session
    TTL, and there are no guest sessions to expire. Delete the line.

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

- 46923cc: Internal refactor: core's six highest-cognitive-complexity functions are decomposed into named helpers. `applyStep` and `reshapeShape` (reshape.ts) each split one branch per reshape op; `validateAppDocumentUnsafe` (app-document.ts) splits one function per cross-field rule; `validateTreeUnsafe` (genui/tree.ts) splits the query block and the node walk; `parseAttributes` (genui/wire/attributes.ts) splits the `=`-value forms and the duplicate-attribute message; `prescanDeclarations` (genui/wire/compile.ts) splits the `<Query>` and `<Island>` pre-scan branches. Every extracted helper is module-private and every message, order of checks and return value is unchanged. **No public surface changed** — not one exported symbol, signature or type moved, and no test file was touched.
- b50a766: Core drops nine exports nothing calls. `inferFieldSemantic`, `humanizeEnumValue`, `semanticAtPointer`, `semanticFormatToken` and `describeSemantic` were orphaned when the dev-server inference pass was deleted — the semantics that reach generation come from the judge and the host's `overrides.json`, and no consumer in the monorepo or the console has called these since. `startSseKeepalive` was justified by "the `vendo try` dev server writes to a Node `ServerResponse`", a surface that does not exist; `withSseKeepalive` is the live keepalive and is untouched. `VendoApprovalWirePart`, `VendoConnectWirePart` and `requestNumberValues` had zero references. `declaredMoneyUnit`, `describeShapeWithSemantics`, `fieldSemanticSchema`, `toolSemanticsSchema` and the money-name regexes behind them are unchanged, and `declaredMoneyUnit`'s test now also pins the "a bare total is a count, not money" rule the deleted inference test carried.
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

- ee92750: The `$expr` fact check and the evaluator agree about `days_until`.

  `days_until(invoices.due_date)` reads the `due_date` COLUMN off every row, and the
  evaluator has always refused it — "days_until() reads one date, but
  invoices.due_date is a list of 3". The static check looked past the column at its
  items, saw strings, and passed. So a generated app shipped through the fact check
  clean and then rendered the contained data-shape notice instead of the number the
  model was asked for. `days_until` is now checked as the scalar slot it is, with
  the evaluator's own repair sentence. The check/evaluator agreement table that
  landed with the two-level column paths grows the three rows that cover it.

  Two smaller compiler corrections ride along. A duplicate attribute whose LAST value
  was dropped (single-quoted, ill-formed UTF-16, an invalid action) was still reported
  as "the last one wins", which sent a retry back to re-write the value that never
  landed; the message now names the outcome — including the case where EVERY value
  was dropped and no attribute survives at all — and two compiler-owned `id`
  attributes no longer claim a winner where both are ignored. And `compilePlan`'s
  issue list — which is verbatim the model's retry prompt — is capped at 64 with a
  final count, the way the wire compiler already caps its own; a broken document
  previously minted one sentence per stray token with no bound. That count reads
  "1 further problem was not listed" when exactly one is omitted.

  Internal only, no public surface change: the wire attribute layer's dead `patch`
  element mode, its action-attribute regex duplicated into the printer, and
  `state.ts`'s pass-through re-export of `isWellFormedUtf16` are gone.

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

- 89660d1: Three compiler correctness fixes: the inline-ref pre-pass no longer rewrites text children or quoted attribute values (only attribute expressions are scanned for inline tool calls), a stray close tag inside a `<Group>` no longer ends the group and drops the leaves after it, and `checkExpr` now resolves a column exactly as the evaluator does — one array level per hop, so `sum(orders, "lines.cents")` passes the check as it has always evaluated, while a list the field's own type declares, and any list in `difference()`'s two scalar slots, are rejected by both halves.
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

- a004031: **BREAKING:** the deprecated V2 aliases from the pre-de-versioning naming
  (0.4.x) are removed: `compileWireV2`, `printWireV2`, `validateTreeV2`,
  `VENDO_TREE_FORMAT_V2`, `treeV2Schema`, `treeQueryV2Schema`, `TreeV2`, and
  `TreeQueryV2`. Each was a pure re-export of its unversioned name — use
  `compileWire`, `printWire`, `validateTree`, `VENDO_TREE_FORMAT`, `treeSchema`,
  `treeQuerySchema`, `Tree`, and `TreeQuery` instead. The rename is mechanical:
  drop the `V2` suffix.
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

- b022eb3: Add `@vendoai/harnesses` — the runtime that runs any harness, plus `vendo()`.

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

## 0.7.0

### Minor Changes

- 8f5a7c0: A failed turn now carries its own error, so the thread never shows a blank
  reply.

  When a turn's stream errored, the only trace on the wire was the ai-SDK `error`
  chunk. That chunk belongs to no message: it sets `useChat`'s transient `error`
  and nothing else. The turn itself persisted as an assistant message with **zero
  parts**, so the moment the thread was re-read — a reload, a thread switch,
  `VendoPage` refetching after the mint — the explanation was gone and the user's
  question sat there answered by a blank bubble. On a keyless install that
  blank bubble was the whole first experience: the server logged `Vendo found no
model key…`, the panel showed nothing durable.

  The agent now writes the same gated string (`wireErrorMessage` — Vendo's own
  crafted text or the fixed generic line, never provider internals) into the turn
  as a `data-vendo-turn-error` part beside the error chunk. It persists with the
  turn, and the thread renders it inline where the reply would have been, in the
  failed-beat vocabulary a failed app build already uses. The live banner keeps
  its Retry but drops its detail line while the turn is already saying it, so the
  same sentence is never printed twice.

  Additive to the wire (§15 forward-compat): consumers that don't recognize the
  part ignore it.

## 0.6.1

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

## 0.5.0

### Minor Changes

- cbffc9e: Freeze the knowledge contract: `KnowledgeAdapter` seam with declared capability postures, chunker/embedder interfaces (local-engine internals), the `vendo/knowledge-hash@1` doc-hash manifest schema, and a posture-adaptive conformance kit with an in-memory stub adapter.
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

- da9d4a9: Draft the knowledge wire protocol (`vendo/knowledge-wire@1`): the HTTP profile of the `KnowledgeAdapter` contract — mount-relative endpoint paths, request/response schemas, the standard error envelope with its status table, and pure error-mapping helpers — plus two new behavioral conformance cases (fetch-side visibility, real limit truncation).
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
- d1364b6: Chrome wave: split-view workspace with morphing stage, compact embeds, staged blur, stage pinning (host onPin seam), AutomationCard, ConnectCard lifecycle states, landing composer, docked new-reply banner, streaming skeletons, WorkingRibbon, connect-dock resilience, ApprovalSheet fixes, approvals-decided resume event, and eventOutcomeLabel stream-part semantics.

### Patch Changes

- 0b58e3e: Generation now rejects capability substitution: a mutating host tool invoked with a hand-typed target or amount is sent back to repair instead of shipped. The live defect this closes had a generated island calling `host_transferMoney({ amount: 1, recipient_name: 'Slack Forwarding Bot', memo: 'APPROVED TRANSACTIONS: …' })` on a host with no messaging tool — a payments API used as a message channel, with a real side effect. The rule is mechanical (argument provenance, not intent matching): operands that arrive through tool data, user input, form state, or a row the user acted on always pass; the values the user themselves named in their request always pass; enums, flags and consts a tool declares never trip it. Both surfaces are covered — declarative action payloads and `tools.*` calls in island source. When the host lacks the capability, the honest disclaimer path is the only valid answer.

## 0.4.8

## 0.4.7

## 0.4.6

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

## 0.4.3

## 0.4.2

## 0.4.1

### Patch Changes

- b7a860f: Release pipeline hardening: the release gate now runs the PostgreSQL store
  suite like CI does, and publishing uses npm trusted publishing (OIDC) with
  provenance — no npm tokens anywhere. This patch is the first release cut
  end-to-end by the automated pipeline.

## 0.4.0

### Minor Changes

- 49e9ccc: Add database-level atomic claims for multi-instance OAuth code redemption and refresh-token rotation.
- 0032a67: Add optional atomic record claims and revision CAS, use them to deduplicate multi-instance automation firing, and abort in-process agentic runs when stopped.
- 4b8ac66: Per-user connected accounts via the Composio broker (ENG-262). Connectors gain a subject-scoped `connections` capability (list/initiate/status/disconnect); the umbrella serves per-principal `/connections` endpoints with a Vendo Cloud broker seam behind `VENDO_API_KEY`; a Composio call missing a connection returns the new typed `connect-required` tool outcome, rendered by `VendoThread` as an inline connect card that retries after connecting; `ConnectedAccountsPanel` (list + disconnect) joins the chrome as the accounts tab. Composio tools carry curated risk (metadata hints + slug patterns) instead of a blanket `write`; the MCP connector accepts an async per-principal `headers` resolver with per-subject sessions; every connector execution is audited with its account identity.
- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.

### Patch Changes

- b6def0f: Capture capability misses from embedded agent runs in a local JSONL sink and,
  when a Cloud API key and telemetry consent are present, upload them in bounded
  best-effort batches with the canonical enabled-tool surface.
- fa0ad98: Test hardening (ENG-255): wire v8 coverage across every package with a ratcheted
  per-package line-coverage floor enforced in CI (`pnpm test:coverage`), remove
  `--passWithNoTests` so empty suites fail, add dedicated unit tests for the
  thin/zero-test hot paths (core schemas + component-map, agent prompt, store
  run/audit helpers, automations engine), and add cross-block journeys J8 (actions
  OpenAPI sync callable over the wire), J9 (Postgres durability + restart drill),
  J10 (multi-tenant concurrency isolation), and J11 (telemetry allowlist wire).
  No runtime behavior changes.
- 51f3fc9: Fix (ENG-353): heartbeat-armed idle-abort fallback for client disconnects the runtime never surfaces. Under `next dev` a real browser's graceful tab-close/navigate-away fires neither `request.signal` nor a stream cancel, so an abandoned turn ran to completion and burned provider tokens. The panel now beats `POST /threads/:id/heartbeat` while a turn streams; the first beat arms a server-side idle watchdog that aborts the turn through the same controller as the fast path after ~15s of silence. The fetch-abort fast path is unchanged, and consumers that never beat (curl/scripted clients) keep exact run-to-completion semantics.
