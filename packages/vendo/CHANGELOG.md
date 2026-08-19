# @vendoai/vendo

## 0.31.0

### Patch Changes

- bf47c34: Every text this channel sends now says whether it is the last one. A reply the
  model splits at a divider goes out in pieces, and until now each piece looked
  exactly like a whole answer on the wire — so the far side could only guess
  whether to keep the typing indicator up or take it down, and it guessed wrong in
  both directions: dropped between "On it." and the answer, or left spinning after
  the last word.

  `ChannelsService.send` takes an optional `final`, and the Cloud adapter passes it
  straight through to `/api/v1/channels/text/send`. Optional on purpose — a host
  carrying its own texts keeps the implementation it already wrote, and a carrier
  with nothing to do with the flag ignores it.

  The flag scopes to one MESSAGE, never to the turn. It says "no more of this text
  is coming", not "nothing else will arrive" — nothing could say the second one,
  because `vendo_text_me` and an automation firing reach the same conversation at
  any moment, and a turn's own grant-set question is decided from the live approval
  feed only after the reply has gone out. A receiver reads it to stop showing a
  reply as still-being-written, never as "stop listening".

  The value is decided by what each send truthfully is, never by position. Only
  `streamTexts` has a mid-reply cut to declare, and it reads finality off the
  stream rather than off the divider: the segment goes out the moment its divider
  passes, and what comes next may be a tool call that takes three seconds or
  nothing at all, so the end of the stream is what settles it. That is also what
  marks the last text of a reply signed off with a divider — that cut is only
  recognized once the stream has ended. Everything else is one whole message with
  nothing behind it: an approval card and a grant-set ask are questions the
  conversation then waits on, the set receipts and the "you're linked" ack end
  their exchange, and a `vendo_text_me` push has no stream behind it at all.

- bf47c34: Three things a texted reply used to wait for, and now does not.

  The host's memberships seam was asked FIRST, before the turn did anything else —
  a round trip in front of somebody holding a phone, taken for a ctx that nothing
  until `harness.stream` reads. It is now started at the top and awaited at the
  ctx, so the guard and store reads a YES/NO costs overlap it instead of queueing
  behind it, and a YES that settles an automation's grant set — which builds no
  ctx at all — never waits for it.

  The link write moved BEHIND the answer. It has two readers and only one of them
  can run during the turn: `vendo_text_me` reads the conversation off that row
  (text-me.ts) and nothing else writes it, so a turn that would change what it
  reads — a phone's first ever, a conversation that has moved — still waits. The
  other reader is the next text on this conversation, and the per-conversation
  queue cannot start that turn until this one's promise settles, so awaiting the
  write below the reply is early enough for it.

  And `vendo_automate` joins the always-active set beside `vendo_text_me`. The
  belt is cut safest-first at 24 tools, so on a surface with more reads than that
  every WRITE is evicted — which is what buried Text me twice in two days. The
  arming tool is a write too, and it is the ONE thing this channel's hidden
  grounding tells the model to reach for on every inbound text ("to text the user
  later, set up an automation for it"). A texted "text me when the rent clears"
  was therefore a `find_tools` round on the first turn of every fresh thread, for
  a capability the prompt had just promised.

- 4b29796: Six mechanical install-DX fixes from a live run of the published CLI. A
  generated `@/lib/vendo` import is a path alias, not the npm package `@/lib`, so
  init no longer writes `"lib": "link:@/lib"` into your package.json and your next
  `npm install` no longer dies on EUNSUPPORTEDPROTOCOL. The predev impact probe
  knocks on the port init wrote to `.env.local` as `VENDO_BASE_URL` instead of
  assuming 3000, so `pnpm dev` on any other port stops reporting "impact unknown".
  `vendo login` keeps its machine-readable JSON receipt off a terminal a human is
  watching, and its one-line pretty ceremony now names the approval URL up front —
  the browser open is best-effort, and a headless box was left with a code and
  nowhere to type it. Every rail row is cleared to end of line, so a select redraw
  can no longer leave a longer line's tail behind. A failed AI brief polish says
  the install is complete and valid with the default brief and names
  `vendo sync --ai`, instead of printing a raw JSON parser error. And the detected
  stack — framework, router, language, package manager, auth — is read back before
  the first question on every run, not only the ones dressed in the rail.
- Updated dependencies [de24421]
- Updated dependencies [457dfe3]
  - @vendoai/automations@0.31.0
  - @vendoai/agents@0.31.0
  - @vendoai/core@0.31.0
  - @vendoai/store@0.31.0
  - @vendoai/actions@0.31.0
  - @vendoai/guard@0.31.0
  - @vendoai/apps@0.31.0
  - @vendoai/harnesses@0.31.0
  - @vendoai/ui@0.31.0
  - @vendoai/mcp@0.31.0
  - @vendoai/knowledge@0.31.0

## 0.30.1

### Patch Changes

- Updated dependencies [6bbc8e6]
  - @vendoai/apps@0.30.1
  - @vendoai/actions@0.30.1
  - @vendoai/agents@0.30.1
  - @vendoai/harnesses@0.30.1
  - @vendoai/mcp@0.30.1
  - @vendoai/store@0.30.1
  - @vendoai/ui@0.30.1
  - @vendoai/core@0.30.1
  - @vendoai/guard@0.30.1
  - @vendoai/automations@0.30.1
  - @vendoai/knowledge@0.30.1

## 0.30.0

### Minor Changes

- bd1d016: Screens are natural JavaScript now. Reads take inputs and resolve through a
  supply loop that keeps the screen's state alive; per-row and plain slots take
  real closures; the `field=`/`semantic:` dialect, the slot law, the nesting
  whitelist and both auto-repair regexes are deleted. The sealed VM borrows the
  host's Intl, so money, dates, durations and "2 hours ago" print what a browser
  prints, pinned to the host's locale and zone. The Kit's surface answers the
  ecosystem's conventions — `value=`, `name`/`header`/children accepted, column
  `width`/`truncate`/`priority`, human durations, `grow`, icon/loading buttons,
  option groups — and twenty silent misbehaviors now speak up or behave. The
  screen agent's brief sheds the rules whose reasons died, gains worked examples,
  and tells the truth about the frame: everything the ask names must be visible.

  Breaking: the value-formatting tier is deleted — `Money`, `Percent`, `Num`,
  `DateTime` and the container `format` tokens are gone; screens format with the
  host-bridged Intl in their own code (chart axes keep a format token, the one
  place a value never passes through screen code). Also: `field=`,
  `semantic:`, `Percent whole` and the `percent` format token are gone — divide
  and scale where you prepare the data; slots accept elements or functions.

### Patch Changes

- Updated dependencies [b3d92b2]
- Updated dependencies [bd1d016]
- Updated dependencies [56c81b5]
  - @vendoai/apps@0.30.0
  - @vendoai/ui@0.30.0
  - @vendoai/core@0.30.0
  - @vendoai/actions@0.30.0
  - @vendoai/agents@0.30.0
  - @vendoai/harnesses@0.30.0
  - @vendoai/mcp@0.30.0
  - @vendoai/store@0.30.0
  - @vendoai/automations@0.30.0
  - @vendoai/guard@0.30.0
  - @vendoai/knowledge@0.30.0

## 0.29.1

### Patch Changes

- 59aff48: An away run keeps the powers the person granted it. Live 2026-08-19 on
  production Maple, the day after the arming fix: "check my balance and text me"
  was armed with all 33 standing grants, fired on time, read the balance — and
  then told the customer "I don't have a way to send a text message." The grant
  was real; the tool was not on the belt.

  Two mechanisms, one silence. The starting toolbelt is cut safest-first at 24
  tools, and Maple's away surface is 25 reads and 6 writes, so every WRITE was
  evicted — `vendo_text_me` with them. Everything past the belt is meant to be one
  `find_tools` search away, but the away and delegated briefs hardcoded
  `discovery: false` on the belief that an away run carries no discovery rails.
  It was never true: an away run thinks on the SAME composed `vendo()` a chat turn
  does, `find_tools` is one of that brain's own hands, and the model was simply
  never told it was holding one.

  Both halves are closed. `vendo_text_me` joins the always-active set, so a
  granted way to reach the person is never what the cap displaces — the first
  honoring of a contract the `loadout` docs have stated since ENG-252 ("Vendo's
  own `vendo_*` tools are always active") and nothing implemented; the rest of it
  waits for the loadout redesign. And the discovery rail is DERIVED from the
  harness that actually runs, in one place every path now shares, instead of being
  written four times with three of them hardcoded off — an uncurated surface is
  still told about nothing, because it still has nothing.

  The demo bank raises its own belt to 64 alongside this. The 24 default is sized
  for a 600-tool catalog; Maple's whole surface is ~31 tools, inside the 30-50
  band where selection accuracy is best, and the default's safest-first cut is
  what buried its writes twice in two days.

- a607261: A texted turn's opening store calls now go out together. The user's message was
  written only after the turn's opening read came back, because on a web turn that
  read is what shapes the write — it decides whether the thread is being created,
  it supplies the listing title, and it is what `validateUpsert` checks a client's
  message against. None of that applies to a text: the message is built in-process
  from a delivery Cloud already authenticated, and the thread id comes off the link
  row, which only carries one because a turn already ran on that thread. So the
  channel path vouches for both facts and the write rides beside the read instead
  of behind it, taking one more round trip off the front of every reply. Web and
  API turns are untouched, and the marker that carries the vouch is a symbol that
  is not exported and cannot arrive on a JSON body.
  - @vendoai/core@0.29.1
  - @vendoai/store@0.29.1
  - @vendoai/actions@0.29.1
  - @vendoai/guard@0.29.1
  - @vendoai/apps@0.29.1
  - @vendoai/automations@0.29.1
  - @vendoai/harnesses@0.29.1
  - @vendoai/ui@0.29.1
  - @vendoai/mcp@0.29.1
  - @vendoai/knowledge@0.29.1
  - @vendoai/agents@0.29.1

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

- 6bc5cc8: Any REST API with a spec becomes agent tools. `openApiConnector({ spec, baseUrl,
headers, name })` takes an OpenAPI document — JSON or YAML text, or an
  already-parsed object — and hands the agent one guarded tool per operation,
  named `openapi_<name>_<operationId>`.

  It brings nothing new to do it. The document goes through the SAME extractor
  `vendo sync` runs over a spec in your repo, so path parameters, query
  parameters, the JSON request body and the declared response schema arrive
  exactly as they would from `.vendo/tools.json` — and risk comes from the method,
  `DELETE` destructive and everything else `ungraded` until something authorized
  grades it. The call then executes through the SAME HTTP dispatch a host tool
  executes through. A spec behaves identically whichever door it comes in, which
  is the point: there is no second code path to keep in step.

  `spec` is the document, never a path and never a URL. Reading and fetching stay
  the caller's business, so the connector works on every runtime and no argument
  of it can be steered into a request.

  Two factorings paid for that sharing, and together they delete far more than
  they add. `extractOpenApi`'s document half is the pure `openapi-document.ts`
  now, with `sync/openapi.ts` keeping node:fs and the spec-file entry points — the
  connector could not import from `sync/`, whose graph carries the TypeScript
  compiler the portability gate forbids in a Worker bundle outright. And
  `registry.ts`'s HTTP leg — argument binding, path substitution, the tRPC
  envelope, the fetch, the JSON envelope — is `runtime/http-dispatch.ts`, used by
  the registry and the connector both.

  `headers` takes static headers or a per-call resolver, the shape `mcpConnector`
  already had. That resolver's context was never MCP's, so it is
  `ConnectorAuthContext` now; `McpAuthContext` and `McpHeadersResolver` keep
  working as deprecated aliases of the connector-wide names.

  Both connectors are exported from `@vendoai/vendo/server` — and so from
  `vendoai/server` — so bringing an outside API in is one import from the
  umbrella, and both are documented at `/capabilities/connectors`, which is
  `mcpConnector`'s first page.

- 06b352b: An automation armed from a phone can now be allowed to run from that phone. On
  2026-08-18 a user set up "check my checking balance every 15 minutes and text
  me" entirely over iMessage. The arming approval worked — the card went out as a
  text, their YES decided it — but arming also minted four pending standing-grant
  captures, and those asks are approval ROWS the engine writes during
  `vendo_automate`, never stream parts, so the mid-turn card watcher could not see
  them and their only surface was the host app's web approvals feed. A person who
  only texts can never reach it: every firing then ran without the Text me
  permission, and the agent could only report that "there are still some
  permissions pending approval" with nothing the person could do about it.

  After a channel turn finishes, one automation's outstanding permissions now go
  out as ONE more text — the automation named the way every other surface names it,
  one line per thing to allow, each line the descriptor's own human title:

      check my checking balance and text me — needs your permission to run on its own:
      - Text me
      - Look it up in the docs
      Reply YES to allow all of these, or NO to cancel it.

  YES decides the whole set in one batch call on the same guard door the web feed
  uses — all-or-none, never a half-granted set — and each approval settles into its
  standing grant through the automations engine's own decision subscriber. NO is
  the bare no it has always been: nothing is minted and the automation is turned
  off, and the reply says which of the two happened. The consent model is
  unchanged — the same captures, the same grants, the same one decision that
  settles them; only the delivery is new.

  One question at a time, the discipline the cards already keep: nothing goes out
  while the conversation is holding a card or a set ask it has not answered, the
  row is written only after the text lands, and a set is never asked twice. The
  store's pending feed is the source of truth rather than "did this turn arm
  something", so a set minted from the web is asked on the next texted turn too.

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
- 0484a15: The approval ask words its schedule and survives a verb-phrase title. Live
  2026-08-18, arming a balance check over text asked as "Set this to run on its
  own needs your approval: - when: _/15 _ \* \* _" — a sentence collision for a
  header and a cron expression as the one thing the person must understand
  before saying yes. The header gains an em dash ("Set this to run on its own —
  needs your approval:"), a schedule-shaped value is worded beside its verbatim
  self ("every 15 minutes (_/15 \* \* \* \*)" — beside, never instead: the ask is
  the consent boundary), argument labels cut at the first comma as well as the
  first period, and the automate tool's `when` property leads with the label
  consent surfaces show ("When it runs") while keeping its format teaching.
- 3ba3e73: A parked call's one line says what is waiting, not what state it is in. The tool
  pack minted it as "Awaiting user approval: List your todos — host_getTodos
  {…}", and `<VendoApprovalEmbed>` titles the card with that line for the rest of
  the request's life — so after the person pressed Approve, the receipt read
  "Awaiting user approval: List your todos" directly over its own "Approved —
  ran". The mint now describes only the call; the state stays with the surface
  that knows it, which was already saying it on the line underneath. The line
  keeps the guard's preview vocabulary, so a BYO loop reads the same call it
  always did.
- 3d85eb5: The approval text reads like a text, not like machinery. The channel's ask
  rendered the guard's raw preview — tool identifier and JSON blob included —
  so a live $25.00 send asked for consent as
  `host_transferMoney {"amount":2500,"recipient_name":"Jordan Avery"}`: a
  voice-rule violation (the identifier reached the person) and a genuinely
  dangerous read (2500 cents scans as twenty-five hundred dollars, in the one
  message whose whole job is informed consent). The ask now renders one plain
  line per argument, labelled from the host schema's own property description
  when it has one ("Amount in cents: 2500") and the spaced-out key when it
  does not; values stay verbatim — the ask is the safety boundary, so nothing
  is paraphrased — capped only so one huge argument cannot flood a text. The
  header also stops saying "needs your OK": the decider matches only YES/NO,
  so a header that says OK teaches the one reply that would not decide it —
  it now reads "needs your approval … Reply YES to approve, or NO to cancel."
- 401ecc4: An inbound text is claimed in one round trip, not two. The delivery log decided
  a claim by reading the row and then writing it, so every text on a hosted store
  waited through two serial store calls before anything else could start — and two
  genuinely concurrent copies of one delivery could each read the absence and both
  run the person's turn, with a second tool call and a second charge behind it.
  The claim is now the adapter's own guarded insert where there is one, which
  answers both. An adapter that omits `atomic` keeps the read-then-write it always
  had: slower, never different.
- ebf101a: A texted reply arrives the way a person texts. The channel used to buffer the
  whole turn and send one message at the end, so the answer landed as a wall well
  after the model had written its first sentence. The model now decides where one
  text ends and the next begins — the texting style note teaches a line containing
  only `---` as the cut point — and each segment is sent the moment its divider
  passes, with the divider itself stripped and never delivered. A reply with no
  divider in it is simply one text; there is no structural fallback.

  Four latency and reliability fixes ride with it:

  - **Prompt-cache warming for texts.** The web has warmed the provider prefix
    since a chat surface opens; a texted conversation never did, so every text in
    a back-and-forth paid a cold prefix. The channel now warms after the reply is
    out — never something the person waits behind.
  - **Fewer store trips before the turn starts.** Delivery dedupe and the phone
    lookup are independent questions, so they are asked together instead of one
    after the other, and the delivery-row prune stops running on every single
    message — it re-listed and re-deleted the whole conversation before the turn
    could start, and is now a sweep.
  - **A dropped reply is retried, and its loss is said out loud.** The channel
    adapter now uses the same keep-alive connection pool as every other Cloud
    adapter (Node drops an idle socket after ~4s, so a conversation's second text
    paid a fresh TCP+TLS handshake) and retries a failed call three times. A reply
    that still cannot be delivered logs `vendo.channel-reply-lost` at error level
    rather than vanishing; the delivery claim is deliberately not released,
    because replaying the turn would re-run the tool calls it already made.
  - **Two rapid texts stay on one thread.** They used to run as concurrent turns
    that each read the link before either wrote its thread back, so each minted
    its own thread and one was orphaned — a forked conversation whose second reply
    had no idea what the person had just said. Turns are now serialized per
    conversation in-process, and the second runs on the thread the first left.
    A YES/NO answering a card deliberately skips that queue: the turn it releases
    is the one holding it.

- 1dce317: `vendo init` stops deciding things for you in silence, and the install it leaves
  behind can compile what it wrote.

  A run that cannot ask no longer answers. Piped stdin and CI used to settle the
  use case doctor grades against, the auth the agent acts as, the model story and
  the dev origin, then print the same success frame an attended install prints —
  so nothing said a decision had been made and the first sign was a tool call
  failing days later. Such a run now prints the defaults it would take, each
  naming the flag that answers it, and exits non-zero; `--yes` proceeds and still
  says what it settled.

  `--agent` grades. Judgment was "delegated to you" on the grounds that the caller
  is a model, but the pass is a scripted engine run with a verbatim quote behind
  every proposal and an independent skeptic over each one, so every agent install
  shipped a catalog whose every tool asked on each call. It now runs the pass with
  whatever engine resolves, asking nothing; with no engine on the machine at all
  the receipt hands the checklist back as REQUIRED work and says so out loud.

  The use-case question reads the evidence the scanner already had: a host whose
  own API runs an agent loop gets "through your own agent loop" recommended, with
  the route named, in both the interactive select and the `--agent` question form.
  The `--agent` auth question gained the same detection interactive mode has, so
  `none` is recommended — and says why — when no auth dependency is there.

  Repairs to the rest of the install:

  - A re-run over an existing composition no longer refuses the MCP door with
    "wire an auth preset". Init never re-decides auth for a file it did not write,
    so the file itself is read instead.
  - `VENDO_SERVICE_KEY` is reused when the host already has a well-formed one,
    instead of being reminted and written over the key every backend caller was
    already exchanging.
  - Every package the generated files import is now a declared host dependency:
    the backend path's docs never install `@vendoai/vendo`, so a host following
    them got a `lib/vendo.ts` importing a package its build could not resolve.
  - `VENDO_BASE_URL` reaches `.env.local` from any attended terminal. The question
    borrowed the run-wide interactivity flag, which folds in "a package script
    launched this" — and npm sets that for every `npm run …` — so the same person
    in the same terminal was asked by `npx vendo init` and not asked at all
    through a wrapper script.
  - No `<VendoProvider>` / `<VendoOverlay>` paste for an agent-loop or MCP
    install, which mount no Vendo UI by design (the rule doctor already grades by).
  - The agent-loop snippets compile as printed: they declare the `principal` they
    pass — resolved from the preset the composition wires, or the same anonymous
    literal the composition resolves — name the host's real chat-route path under
    `src/`, and name the Mastra agent file the host actually has.
  - Five stale docs URLs, and a test that maps every docs.vendo.run URL the CLI
    can print to a file under `docs-site/`. Doctor's `fix_ref` now lands on the
    code's own troubleshooting page instead of a retired playbook with the code in
    a fragment the server never sees.
  - The judgment receipt names the file the grades landed in and the merge that
    keeps `tools.json` saying `ungraded` — three auditors read the old receipt and
    concluded the pass had done nothing — and tells you to restart the dev server,
    which read the judgments once, at boot.
  - `vendo ready` and the hosted-store notice are latched per PROCESS, not per
    module. Next's dev server re-instantiates the module graph, so both came back
    every couple of seconds and flooded the log.

- ebf101a: A tool call is decided once instead of twice. Every guarded call ran the whole
  policy pipeline twice for one logical call: the harness previews with
  `previewCheck` before it dispatches, and the guard-bound registry then evaluated
  the same call again from scratch moments later — the grants read, the approvals
  read, the rules, the org layer and, worst of all, the judge (up to 15 seconds,
  paid twice). The preview's verdict now carries to the dispatch that follows it,
  single-use and pinned to that exact call: same id, same arguments, same
  descriptor, same subject, venue, presence and app, or it is decided fresh.

  Nothing the guard refused before gets through. The preview was always the whole
  evaluation — it just never SPENT anything — so the dispatch is what commits, and
  a verdict only answers for the dispatch moments behind it: it expires after five
  seconds, and every gate that can still stop the call is re-read before anything
  is spent. The kill switch is read first, so a freeze landing between the two
  passes no longer burns the human's single-use yes on a call it then blocks. The
  call-rate window and the write budget are read live and can still park a
  previewed "run" that a concurrent call has since put over budget. The org-admin
  layer is consulted again, so an admin who tightens the layer while a call sits
  previewed clamps that call. The risk GRADE is re-resolved rather than remembered,
  so a tool that previewed as `read` and re-grades to `destructive` cannot reach an
  away run on the old label — THE LAW's unattended gate never reads a stale grade.
  A standing grant is re-read and the single-use yes is claimed last, after every
  gate above, so a call that does not proceed spends nothing. Any of these voids
  the verdict and the full pipeline decides again. An "ask" is never carried
  forward at all — the tap that answers it IS the fresh verdict the dispatch reads.

  The judge is asked once per call, so a subject's outstanding previewed verdicts
  are voided the moment ANY call for that subject lands — at any risk grade, in any
  run or session. The judge decides on the audit trail, and that trail is the
  subject's, not the run's: a step whose tools were all previewed before any of them
  dispatched would otherwise let the second call run on a verdict taken before the
  first one existed, and a landed read or a landed connector call is exactly the
  shape a judge most wants to weigh. Sequential calls — preview, then dispatch with
  nothing in between — have no outstanding verdict to void and keep the single pass.

  Host-API calls also ride the keep-alive connection pool the store already uses.
  Node's stock dispatcher drops an idle socket after ~4s — shorter than the gap
  between two of an agent's tool calls — so nearly every host round trip was paying
  a fresh TCP+TLS handshake. Inference rides the same pool: the composed model
  seats now dial the Cloud gateway through it, so a turn does not re-handshake
  after every idle gap. A host that passes its own `fetch` — or its own ai-SDK
  model object — still wins.

  A refused connect check costs one broker lookup instead of two. The connect gate
  runs twice for one tool call — the harness preflight rules a call to an
  unconnected service out before an approval can be minted for it, and the
  gate-wrapped registry rules it out again on the doors that never preview — and
  only the CONNECTED answer was cached, so every unconnected call asked the broker
  twice to say the same no. A negative answer is now trusted for one second: long
  enough for the two checks of one call, far short of an OAuth round trip, so a
  user who just connected is never told otherwise.

- ebf101a: A turn stops doing its setup one thing at a time. The system prompt is now
  assembled BESIDE the turn's opening store reads instead of after them, and the
  two independent waits inside it — the guard's directions and the knowledge index
  — run together rather than in sequence; the assembled bytes are unchanged,
  because section order comes from the assembler and not from which read settles
  first. The runtime no longer re-validates the composed turn's transcript against
  itself: composition hands it the very array it just read and validated, and one
  array cannot differ from itself, so an O(n) double stringify per turn was
  spent proving a tautology. `vendo()` projects the host's catalog once to set a
  turn up instead of twice, and re-projects it after a tool call only when that
  call could actually change what is reachable — the connector door — rather than
  after every call.

  Fixes a compaction accounting bug in the same pass: the prompt estimate billed
  every equipped tool while the call only ever carries the active loadout, so a
  curated surface was charged for a catalog it never sent — the trigger fired on
  tokens that were never there, and the shed floor was handed a figure the prompt
  had never reached. The estimate bills the active set now. The characters-per-token
  ratio is unchanged.

- Updated dependencies [6bc5cc8]
- Updated dependencies [ebf101a]
- Updated dependencies [ebf101a]
- Updated dependencies [6bc5cc8]
- Updated dependencies [0484a15]
- Updated dependencies [5fa346d]
- Updated dependencies [3ba3e73]
- Updated dependencies [06b352b]
- Updated dependencies [df0b4cb]
- Updated dependencies [7e78031]
- Updated dependencies [7e78031]
- Updated dependencies [ebf101a]
- Updated dependencies [ebf101a]
- Updated dependencies [6bc5cc8]
- Updated dependencies [f06b033]
- Updated dependencies [1dce317]
- Updated dependencies [ebf101a]
  - @vendoai/core@0.29.0
  - @vendoai/ui@0.29.0
  - @vendoai/harnesses@0.29.0
  - @vendoai/actions@0.29.0
  - @vendoai/apps@0.29.0
  - @vendoai/automations@0.29.0
  - @vendoai/guard@0.29.0
  - @vendoai/knowledge@0.29.0
  - @vendoai/store@0.29.0
  - @vendoai/agents@0.29.0
  - @vendoai/mcp@0.29.0

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

### Patch Changes

- 7ba8318: A human typing `npx vendo init` is a human, not a script. `npx`/`npm exec` runs
  its target as a synthetic package script literally named `npx`, and the CLI read
  any `npm_lifecycle_event` as proof a lifecycle hook had started the run — so the
  command every doc prints came up mute: the use-case question, the auth confirm,
  the deploy URL and the AI-grading consent were all skipped and the run silently
  took "embedded". Only that one synthetic name is exempt now; real hooks
  (`predev`, `postinstall`, any `npm run …`) keep their exemption, and the TTY
  requirement is unchanged, so CI and piped runs stay as quiet as they were.
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

- 45a4600: Init asks where the app runs in DEV, and stops asking where it deploys. The dev
  origin is the one Vendo cannot learn: an own-loop tool call, a backend process
  and the MCP door each make a real HTTP request back at the host's own API and
  never see a wire request to read an origin off, so every one of those installs
  met `Cannot execute … set VENDO_BASE_URL` on its first turn — after a run that
  had reported itself finished. Interactive init now asks one question, prefilled
  with the port the host's own `dev` script names, and writes the answer to
  `.env.local` as `VENDO_BASE_URL`. Enter is the whole interaction, and the
  terminal echoes the value it wrote rather than calling an accepted default a
  skip.

  A run that cannot ASK still writes nothing: the prefill is an answer only when a
  person accepts it, and a guessed origin is worse than an absent one — unset, dev
  learns the request's own origin and production fails loud, both unchanged.
  `--base-url` is that same answer as a flag (dev origin, `.env.local`), and it
  travels in `--agent` mode's question list like every other decision a person owns.

  "Where will this deploy?" is gone, with the `.env.example` rewrite that went with
  it. Production is told at deploy time, not asked at init: `.env.example`'s
  `VENDO_BASE_URL` block is now an instruction — dev is already in `.env.local`, and
  the real value goes in the hosting platform's own environment settings, never in a
  committed file and never in `.env.local`, where a public URL would repoint local
  dev's discovery, callbacks and credential forwarding at the deployed origin. The
  MCP arm reads the dev answer for the client URL it prints, so the address a user
  pastes into Claude is the app they are actually running, and its first step now
  points at deploy time for the public one.

  No platform variable is ever consulted: nothing infers an origin from `VERCEL_URL`
  or any sibling. The URL is set by the person who knows it, or it is loudly unset.

- a54af91: A "no tool for that" conclusion now requires the search. The capability-miss
  prompt told the agent to report a no-matching-tool miss "before replying", and
  the discovery section told it to search find_tools "before concluding you
  can't" — two instructions, one situation, and the model may satisfy either. On
  a live text-channel transfer ask it satisfied the first: filed the miss off its
  equipped read tools alone and told the customer it couldn't send money, while
  "Send money" sat one find_tools call away. The miss bullet now names the search
  as the only way to establish "no available tool" on a surface that has one.
- c2805b4: The composition has an address, and doctor knows what the install is for.

  `vendo init` now writes the Next composition to its own module — `lib/vendo.ts`
  (`src/lib/` when the app directory is under `src/`) — exporting `vendo`, with
  the wire route a thin `nextVendoHandler` over it. Every docs page and every
  snippet init prints already said `import { vendo } from "@/lib/vendo"`; that
  file finally exists, so an agent loop, a backend job and the origin-root
  discovery route can all reach the SAME instance instead of composing a second
  wire that shares none of the first one's state. The specifier is the `@/` alias
  where the host declares one and a relative path otherwise, so the generated
  route compiles either way; the MCP path now opens its door in that one module
  rather than a second one beside the route, and the registration map follows the
  composition it is imported from. Existing installs are untouched — init only
  ever creates files, and doctor grades both shapes.

  Init records the resolved use case in `.vendo/install.json`, and doctor reads
  it: an agent-loop or MCP install mounts no Vendo UI by design, so E-WIRE-004
  and E-WIRE-006 no longer fail a host that is correct by construction — doctor
  says which checks it skipped and why. An unattended re-run keeps the recorded
  answer instead of falling back to embedded.

  A missing model credential is a visible warning now (E-MODEL-001) instead of a
  note `--json` swallowed, so an agent stops reading "green" on a host that
  cannot answer a single turn. Doctor still exits 0: production keys live where
  it cannot read them.

  Also: the models question offers "I already have a Vendo key — paste it", so a
  dev with a key stops minting a second one; `.env.example` names the host's own
  dev port instead of always `:3000`, and says out loud that an agent loop and any
  backend process need `VENDO_BASE_URL` even in dev; and every fix-it text that
  reaches a non-interactive audience names `vendo sync --ai`, the spelling that
  actually grades without a consent prompt nobody is there to answer.

- 45a4600: E-MCP-009 grades the door init actually wrote. The composition moved into its own
  module (`lib/vendo.ts`, `src/lib/vendo.ts` under a src layout) and doctor's MCP
  path list never followed, so on every host init scaffolded since then the check
  found no composition at all and said NOTHING — no failure, no check, nothing to
  notice — which is the precise outcome a hard FAIL exists to prevent: a door whose
  discovery advertises the wrong origin, surfacing hours later in someone else's
  terminal as "Claude can't find my server". The list now leads with the current
  module and keeps every legacy location (the route's sibling `vendo.ts`, the inline
  route, the Express and runtime-neutral modules), in the same order
  `doctor-wiring-checks.ts` reads them, so older installs grade exactly as they did.

  Expect the intended failure to reappear: an MCP-wired host with neither
  `VENDO_BASE_URL` nor `mcp: { baseUrl }` fails E-MCP-009 and exits 1, where it had
  been silently green. Interactive `vendo init` now answers it in dev by writing the
  dev origin to `.env.local`; production sets the variable where it deploys.

- Updated dependencies [b9392b9]
- Updated dependencies [650e5eb]
- Updated dependencies [0143c4e]
- Updated dependencies [c2805b4]
- Updated dependencies [62c8630]
- Updated dependencies [919cd75]
- Updated dependencies [1117c45]
- Updated dependencies [0143c4e]
  - @vendoai/actions@0.28.0
  - @vendoai/core@0.28.0
  - @vendoai/store@0.28.0
  - @vendoai/apps@0.28.0
  - @vendoai/ui@0.28.0
  - @vendoai/agents@0.28.0
  - @vendoai/automations@0.28.0
  - @vendoai/guard@0.28.0
  - @vendoai/harnesses@0.28.0
  - @vendoai/knowledge@0.28.0
  - @vendoai/mcp@0.28.0

## 0.27.1

### Patch Changes

- ebe9ffc: A store that will not hold one collection no longer takes the whole deployment down with it.

  0.27.0 on a Vendo Cloud key served 501 to every route. The hosted store's engine allowlist did not carry two of the collections this version reads — `vendo_automations` and `vendo_app_seen` — and the automations one is read at BOOT, by the code-automations reconcile that rides the `ready()` latch. The latch memoizes, so the first refusal became every route's answer for the life of the process: 2.3 seconds for the first request, 3 milliseconds for every one after, all of them 501, including the routes that never touch an automation.

  Three separate faults, and the deployment needed all three fixed:

  The boot reconcile is no longer the deployment. A store that refuses the automations read leaves code-authored automations off and says so once, in a line the operator can act on; everything else serves. Scoped to that one read — every per-request store failure still fails in the open, where the caller can see it.

  The unseen dot costs the dot, never the answer. `vendo_app_seen` was read on the path that LISTS a person's apps and written on every render, so a store refusing that collection took the whole page of apps with it. A refusal is absorbed there now, once per process, and the apps arrive without their arrival dots.

  And `instanceof VendoError` does not survive a realm boundary. A host bundle can carry two copies of `@vendoai/core` — the ESM `dist/` beside the CJS `dist/cjs/` — and the second copy's VendoErrors are a different class with the same shape, so every `instanceof` gate said no. That is why a blocked collection reached the wire's catch-all as an unknown fault and answered "Internal Vendo error" instead of its own 403.

  `isVendoError` is the check that survives it: `name` plus `code`, the two things any of these gates actually read. Every type-gate in the repo takes it now — 48 of them across the eight packages that had one — because the failure was never specific to the wire. The same class of error decided whether a lost compare-and-swap re-aimed or crashed the workspace façade, whether a swept approval rendered "expired" or an error card, whether a host's knowledge adapter got its code named in the operator's log, whether a permission route answered 403 or threw, and whether a build's "busy, try again shortly" read as "generation failed" — a verdict on an ask that was never the problem. `@vendoai/harnesses` proved the duck check first and kept a private copy of it; that copy is now this one function.

- ebe9ffc: A run whose LAST save never reached the screen stops answering "your card is live".

  A screen build saves as it goes, and the run kept two different facts about those saves: `assembled`, which means bytes reached the store at least ONCE and is never unset, and `painted`, which means the LAST save reached the person's screen. The outcome was gated on the first of them. So a build whose early save cleared the checks floor and whose last one did not still answered "assembled" — and because the earlier paint had left a row, the front door found it, stamped the receipt `ready`, and spoke the model's own closing words over a card that was stale or half-written. The field case read "Your card is live!" over an empty one.

  `painted` is a three-state fact now — painted, refused, or nobody judged (an unwrapped workspace claims nothing) — and the outcome is gated on it: a run whose last save the floor refused is `unavailable`, carrying the floor's own sentences, on the same carrier a deployment-level refusal already travels. The person is told what is wrong with the screen they asked for, and MCP callers stop hearing the generic "produced nothing renderable" on an ordinary refusal. A run whose last save painted is unchanged, the reviewer's repair round included: the screen it repairs has already painted, and whatever survives it still stands.

  Also: four `catch {}` blocks that swallowed the cause whole — the BYO tool pack's execute and delegate, and the harness tool bridge's and turn tools' — now say what threw, to the host's log. The wire keeps its generic sentence, because raw internals are not the model's business; a `VendoError` from a host tool was written FOR the model, so the pack and the bridge forward its own code and message rather than masking "list them first" behind "Tool execution failed."

- ebe9ffc: Three lines that promised more than the code does.

  The `DataTable` spec now names the two priors a model keeps bringing to it: a column's header text is `label` — there is no `header` prop — and `paginate` is a page SIZE, so no pagination means omitting it rather than passing `false`. Both mistakes are silent from the model's side: an unknown prop is dropped at validation and `paginate={false}` never parses, so the screen simply comes back missing the thing that was asked for.

  Init's closing line no longer says `vendo doctor` "can start the server and run a live turn". Doctor makes no requests at all — it validates files and wiring — so the sentence sold a check it was never going to run, and a reader who trusted it counted a green doctor as proof the app answers.

  The brief stage's failure note names the artifact it already preserved. `brief stage failed (Unterminated string at position 1873) — keeping the current brief` gave nobody anything to open; it now points at `.vendo/data/extract/brief.json`, where the stage's raw output is written on the way out.

- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [0a06bad]
- Updated dependencies [1fb1810]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
- Updated dependencies [ebe9ffc]
  - @vendoai/core@0.27.1
  - @vendoai/apps@0.27.1
  - @vendoai/guard@0.27.1
  - @vendoai/harnesses@0.27.1
  - @vendoai/knowledge@0.27.1
  - @vendoai/mcp@0.27.1
  - @vendoai/store@0.27.1
  - @vendoai/ui@0.27.1
  - @vendoai/actions@0.27.1
  - @vendoai/automations@0.27.1
  - @vendoai/agents@0.27.1

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
- c50597f: A deployment enrols itself with Vendo Cloud at boot, and derives the secret Cloud signs its wake-up call with.

  Nothing in this repo ever told Cloud that a deployment existed, so the heartbeat had no door to knock on: a hosted deployment served every request, armed its automations, and fired none of them — with no error anywhere to say so.

  **If you set `VENDO_API_KEY` and `VENDO_BASE_URL`, there is nothing else to do.** On the first request after boot (the same `ready()` latch the schema and the boot reconcile ride — construction stays free of I/O for Workers' sake), the deployment posts its own URL and a tick secret to Cloud, and that is the entire enrolment: no dashboard step, no second env var, nothing for a person to configure. Registering is idempotent on (project, host), so every replica and every redeploy calling it is the expected usage, and a re-register also clears Cloud's failure breaker. `VENDO_CLOUD_URL` repoints the console as everywhere else.

  The secret is DERIVED, not configured:

  ```
  HMAC-SHA256(key = VENDO_API_KEY, message = "vendo:automations:tick:v1")  →  base64url
  ```

  Every replica derives the same value, which is the point: they all enrol, and a secret that differed per instance would break the others' knock. The label is frozen for the same reason. It is never logged, never in an error message, and never in a URL.

  ## Whether you still need `VENDO_TICK_SECRET`

  This supersedes the "with `VENDO_TICK_SECRET` unset, both are refused" line in the tick-door note. `POST /api/vendo/tick` now verifies against the derived secret too, so:

  - **On Vendo Cloud** — you do not need `VENDO_TICK_SECRET`. Remove it if you set it only to make the heartbeat work.
  - **Running your own cron, no Cloud key** — you still need it, exactly as before. Nothing changes for you.
  - **Both set** — `VENDO_TICK_SECRET` wins. It is the bring-your-own override, and it is _that_ secret that gets registered with Cloud, so your cron and Cloud's heartbeat present the same one and both legs work.

  With neither set the door still refuses every knock, and its 401 now names both roads out.

  ## When it cannot enrol, you hear about it

  Enrolment never throws and never delays a request — a console blip must not take a deployment down or hold up its first response. It logs at `error` under the code `vendo.tick-enrolment-failed`, once per composition, because an unenrolled deployment is otherwise indistinguishable from a healthy one: it serves everything correctly and fires nothing. Two reasons produce that line — Cloud refused the registration, or `VENDO_BASE_URL` is unset so there is no public URL to publish. If you see it, your scheduled automations are not running.

  It stays silent where there is nothing to publish and nothing wrong: no Cloud key, `automations: false`, and a development process — which fires its own ticks already and sits behind a URL no heartbeat could reach.

  `vendo doctor` reads the same ladder the door does, so a Cloud deployment that configured nothing no longer reports itself as having no schedule caller.

- af2d337: A host tool that is off says so, and a screen with nothing to read says that instead of inventing a tool.

  An extracted tool can be turned off by three different layers, and until now only the all-or-nothing case was ever announced: `warnZeroLiveTools` fired when EVERY tool was dead, doctor passed on any `live > 0`, and the init receipt never mentioned it. So a catalog that shipped 5 tools and served 2 read healthy from every angle, and the missing three were discovered by watching the assistant fail to answer.

  Now the count and the reason travel together. Boot warns once naming each tool that is off and the layer that took it (an override, a judgment, or a non-end-user audience grade). `vendo doctor` warns `E-TOOLS-005` with the same list when live is short of the extracted count — a warning, not a failure, because which exclusions are right is the host's call. The `vendo init` agent tail carries a `tools off:` line with the same names and the one edit that turns a tool back on.

  The generator stops filling that silence with fiction. When no tool on the list can be READ, the briefing says so outright, and a screen that queries an unknown tool with nothing readable behind it is told there is no data for the ask, to use `<Disclaimer>`, and specifically not to claim data is missing or empty when it cannot know. The failure this closes: a model invented a tool name, failed five times, then rendered "No revenue data connected" above a table of that exact data.

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

- 68bb5da: `vendo doctor` checks what is on disk and nothing else. It starts no server, makes no HTTP request, and needs no running app: it grades your wiring markers, your `.vendo/` files, your installed `ai` and `zod`, your ejected surfaces, your `server.json`, and the environment variables the install depends on. Run it any time, in any repo, and it answers in under a second.

  The promise on every install prompt is "you're done when `vendo doctor --json` reports all green", and on the exact stack Vendo recommends that was unreachable. Doctor probed the running app over plain HTTP with no browser session, so an app with a signed-in-user auth preset correctly answered 403, and doctor exited 1 with `E-LIVE-001`, `E-AUTH-003`, `E-AUTH-006` and `E-TURN-002`. A green run now means what it says.

  What went with the probes: `vendo doctor --url` and `vendo doctor --yes`, the `liveTurn` field in the `--json` object, the dev-server-start offer, the live model turn, the `/status`, present-credential, actAs, machines and MCP discovery requests, the npm-latest version hint, and the split-brain version-skew read. The `/doctor/*` routes on the server side are unchanged. These error codes are retired and doctor can no longer emit them: `E-DEP-002`, `E-DEV-001`, `E-LIVE-001` through `E-LIVE-006`, `E-AUTH-001` through `E-AUTH-008`, `E-MCP-001`, `E-MCP-002`, `E-MCP-003`, `E-MCP-005`, `E-MCP-008`, `E-SCHED-001`, `E-TURN-001` and `E-TURN-002`. Each keeps its troubleshooting page, marked retired, so an old report still resolves.

  The seams doctor cannot see, it no longer pretends to: your auth forwarding, your actAs resolver and your model credential are proven by one real call in your own app, not by a synthetic probe against a route your users never hit.

- 6f3cbc0: `vendo init --agent` asks first and then writes, instead of printing a plan nobody could act on.

  Init has one personality in every mode now: it detects, asks, logs in, and writes. Agent mode only changes how the questions TRAVEL. Init emits them as JSON, the coding agent relays them in chat, the answers come back as flags on a re-run, and that run writes.

  The first `--agent` call runs detection and, if anything a person must decide is still open, prints ONE object and touches nothing: `{"status": "questions", "detected": {…}, "questions": [{id, prompt, options}]}`. Each prompt is chat copy an agent relays verbatim, and each option carries the literal thing the agent does to pick it, a `flag` for the re-run or a `command` to run before it. There is no select-vs-confirm machinery: yes/no is two options. The set is use-case, auth and models, plus the sign-in posture and the service key once the use case is MCP. A call that already carries every answer skips the question pass and writes in one go.

  Both passes exit 0. `status` is what a caller branches on, the same idea as `doctor --json`. The write pass ends in a receipt: `{"status": "written", root, useCase, wrote, pasteEdits, tools, riskRecommendations, judgment}`. `judgment` is always `{"status": "delegated"}` with the checklist of what the catalog still needs, because the caller IS a coding agent and agent mode may not spawn another one underneath it.

  **The read-only plan dump is retired.** There is no mode that prints code diffs and stops, and there is no `--plan` flag. No new flags were added for any of this either: `--use-case`, `--auth`, `--cloud-key`, `--byo`, `--posture` and `--service-key` all already existed and already validated.

  Nothing mechanical is ever relayed. The deploy URL, the zod floor, the theme slots and the live check take the same defaults `--yes` gives them and show up in the diff. The interactive terminal flow is unchanged.

  Two wording fixes ride along: `--byo` now states what your own key needs instead of pointing back at `vendo login`, which made the opt-out read as a detour rather than a first-class path; and the packaged `vendo-setup` skill teaches the new flow.

- d45e0c1: `vendo login` names the dead code before it prints the new one, so a human holding a relayed code learns it stopped working instead of typing it into an error.
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

- 8daeabe: The screen agent keeps no door out: `escalate` leaves the loadout.

  A tool the model is never handed is a tool it cannot reach for. The `escalate`
  hand is gone from the assembly loadout and the bullet that taught it is gone from
  the environment note — the loop is equipped with `save_app`, `edit_app` and the
  host's read tools, and its own instructions name nothing else. The step-budget
  line is now just the budget; it no longer offers leaving as the alternative to
  spending it. The shipped building-apps manual keeps its own hedged sentence
  ("hand it to the builder through `escalate`, **where you have that tool**"),
  which is exactly the hedge this change relies on.

  What an ask bigger than a screen costs now: an honest failure. `vendo_make`
  answers with a failed receipt naming the ask, nothing is painted, and no build
  machine is provisioned — even on a deployment that has one sitting there.

  The escalation plumbing downstream is untouched: `ScreenOutcome`'s
  `kind: "escalate"`, the `create({ prompt, why })` door that hands the in-box
  builder a brief, and every `@vendoai/apps` consumer of both still work exactly as
  they did. Nothing in this repo reaches them through the screen agent any more —
  a host that calls `apps.create` with its own `why` still does.

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

- e09d69a: A deployment that cannot check screens now says so once, with the fix, instead of paying a model to rewrite a screen nobody read.

  When `@vendoai/apps` cannot reach esbuild — the field case is a bundled host that never named it an external — the component gauntlet refuses every screen it is handed. That refusal used to travel as an ordinary finding: the screen agent relayed it to the writing model under "Fix each of these, then write the file again", the model rewrote a perfectly good screen, the next save was refused for the same reason, and the run ended in a generic "that build didn't come together" after burning its whole step budget. Nothing anywhere named the one thing that would have fixed it.

  Three changes, one line of cause: the unavailability names its own remedy — keep `@vendoai/apps` out of the server bundle, which on Next is the `serverExternalPackages` list `vendo init` writes; naming `esbuild` alone does nothing, because this package hides that import behind a variable specifier and a bundler never sees an "esbuild" import to match — the gauntlet marks the refusal as the DEPLOYMENT's rather than the screen's, the checks floor carries the mark out (`ComponentPaintResult.environment`), and the screen agent ends the run on it — the floor's sentence becomes the answer the person and the host log both get, at a cost of one model call rather than a rewrite round per save.

  All three of the gauntlet's machines are marked, because all three fail the same way: no compiler (`toolchain-unavailable`), no type checker (`typecheck-unavailable`), and an engine that would not START, which now has its own code (`engine-unavailable`) instead of sharing `run` with screens that ran.

  A screen the floor refuses on its own merits is untouched — including one that RAN and threw, which is what `run` still means. Those sentences are still repair instructions, verbatim, because they are still repairable.

  Also: a run whose every save was refused has no app row — a paint is what creates one — so its `decisions` have nowhere to land. That expected state is an info line now, in the same voice `commitSource` already uses for it, rather than a warning that sends an operator hunting for a broken memory door.

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

- 2f79d98: An alias-wired host reads as wired. The wiring scan's server marker knew only
  the scoped `@vendoai/vendo/server` spelling, so a host importing `createVendo`
  through the unscoped `vendoai` alias was diagnosed "not wired" (E-WIRE-001 /
  E-WIRE-007) by doctor and init alike — and a `VendoRoot` import from the alias
  dodged the E-WIRE-010 legacy warning the same way. Both markers now read both
  supported spellings, like the supabase preset marker before them.
- bfaa06b: A texted turn authenticates its host calls. `presence: "present"` meant two things at once — "a person is here, so ask them to approve" and "forward the caller's browser credentials" — and a text message satisfies the first without the second: there is no request behind it. So a linked customer's tool call reached the host API carrying nothing, the host answered 401, and the agent apologised for a sign-in problem the person could do nothing about. `RunContext` now carries `channelLink`, the text channel's evidence that this subject authorized this phone, and the actions registry authenticates such calls through the ActAs seam — exactly as it already does for MCP-OAuth users, who have no browser session either. Presence stays `present`, because that is what lets the guard ask for approval on a money-moving call instead of refusing it outright.
- 3fe1146: Init's ONE-STEP paste now yields a visible agent: the frame prints
  `<VendoOverlay />` inside the provider wrap (annotated for hosts that render
  their own surface). The paste used to stop at `<VendoProvider>`, which renders
  nothing — a verbatim install completed invisible while doctor E-WIRE-006
  hard-failed exactly that state. One paste, one visible result, and the frame
  finally agrees with the gate.
- e09d69a: `vendo init` now writes the one Next.js setting a Vendo install cannot work without, and `vendo doctor` fails without it.

  On a fresh pnpm + Next.js host every generated screen failed its checks, and nothing else looked wrong: Next bundles `@vendoai/apps` into the server chunk, so the app checker's `import("esbuild")` became a bare runtime resolve from the app root — where pnpm never hoists esbuild, since it lives only under `node_modules/.pnpm/@vendoai+apps…`. Init had never touched `next.config` at all.

  Listing `"esbuild"` does NOT fix it, which is the trap: the checker reaches esbuild through a VARIABLE specifier behind bundler-ignore comments, so there is no static `"esbuild"` request for Next to match against `serverExternalPackages`. The package itself has to be external. Our own examples looked fine only because the monorepo root hoists esbuild; their lists were equally inert, and they now carry `@vendoai/apps` too.

  Init ensures a Next host's `next.config.(ts|js|mjs)` carries `serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"]`: the missing names are spliced into a list the config already keeps, the whole property is added to the object the config exports, or a minimal `next.config.mjs` is created when the repo has none. The edit is deliberately conservative — a config init cannot read as an object literal (a function of `phase`, a computed export) is never rewritten; the line is printed as a paste instead, and reported in both the human output and the `--agent` receipt like every other repair.

  `vendo doctor` grades the same fact statically as **E-CFG-004**, failing on a list that carries `esbuild` but not `@vendoai/apps`, with the exact line to paste in the message. It reads both spellings of the list, so a Next 14 host on `experimental.serverComponentsExternalPackages` passes.

- 3fe1146: A supabase() host learns about its server-side env before the first signed-in
  turn fails. Init's detection now attaches an advisory when it wires the
  Supabase family and neither `SUPABASE_JWT_SECRET` nor `SUPABASE_URL` is in the
  process env or any host env file — the preset verifies sessions with those
  server-side names, not the `NEXT_PUBLIC_*` pair detection saw. Doctor gains
  the matching static check, E-AUTH-009 (a warning: production-only env is
  legitimate), built on the same shared helper so init and doctor can never
  disagree.
- 3fe1146: Next 14 hosts can compile the wire again: the keep-alive pool's dynamic
  `import("undici")` now carries `webpackIgnore`, so bundlers leave it to the
  runtime instead of parsing undici — whose syntax Next 14's webpack cannot
  read — into every wire-route build. Runtime behavior is unchanged: Node loads
  the pool as before, and targets without undici keep the plain-fetch fallback.
- Updated dependencies [c50597f]
- Updated dependencies [e09d69a]
- Updated dependencies [a781798]
- Updated dependencies [e09d69a]
- Updated dependencies [e09d69a]
- Updated dependencies [20aed63]
- Updated dependencies [49e1e39]
- Updated dependencies [af2d337]
- Updated dependencies [a507b92]
- Updated dependencies [c50597f]
- Updated dependencies [a6ec9ba]
- Updated dependencies [c50597f]
- Updated dependencies [bfaa06b]
- Updated dependencies [c50597f]
- Updated dependencies [77a6765]
- Updated dependencies [b10d129]
  - @vendoai/core@0.27.0
  - @vendoai/guard@0.27.0
  - @vendoai/apps@0.27.0
  - @vendoai/store@0.27.0
  - @vendoai/ui@0.27.0
  - @vendoai/actions@0.27.0
  - @vendoai/agents@0.27.0
  - @vendoai/automations@0.27.0
  - @vendoai/harnesses@0.27.0
  - @vendoai/knowledge@0.27.0
  - @vendoai/mcp@0.27.0

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

- Updated dependencies [c369e14]
- Updated dependencies [443edd4]
  - @vendoai/core@0.26.0
  - @vendoai/harnesses@0.26.0
  - @vendoai/apps@0.26.0
  - @vendoai/actions@0.26.0
  - @vendoai/agents@0.26.0
  - @vendoai/automations@0.26.0
  - @vendoai/guard@0.26.0
  - @vendoai/knowledge@0.26.0
  - @vendoai/mcp@0.26.0
  - @vendoai/store@0.26.0
  - @vendoai/ui@0.26.0

## 0.25.0

### Minor Changes

- 374279e: One-text linking over the org's dedicated iMessage router. The router keeps the connect message in its own transcript instead of forwarding it, so the code in `connect @handle CODE` never reached the deployment and linking took two texts. Vendo Cloud now reads that tail off the router transcript and relays it on the existing inbound door as `{ kind: "link", from, code }`, just ahead of the person's first real message: the deployment claims the code silently and then answers what they actually asked, so one text links an account. The typed path still works — a bare code from an unlinked phone claims exactly as before — and a link payload whose code is unknown, spent or expired is a silent no-op, which is what makes a re-relayed connect harmless. Link codes now last 30 minutes rather than 15, because the gap between tapping the anchor and sending the message is human. The channel also states plainly that it cannot send scheduled, recurring or unprompted texts and points at the app instead, so the agent never promises a Friday text that nothing can deliver.
- aa1c8db: The harness turn now opens with ONE `turn.load` and closes with ONE `turn.commit` on a store that serves them. A quiet turn against a hosted mount costs three calls — the envelope, the user's message (landed before the model runs, so a turn that dies never loses it), the envelope — where it used to cost six. Feature-detected against `/status` once per deployment and never blind-sent: below `STORE_WIRE_TURN_OPS`, and on any store with a SQL handle (already one hop from its rows), every door reads and writes exactly as it always did, retry and per-write isolation included. Per-tool-call writes are untouched by design: the guard's audit row, the effect ledger, the workspace commit after every tool call, and the parked-approval checkpoint all stay per occurrence.

### Patch Changes

- 6c26bfd: The config report ships the policy document, not the pointer to it.

  `guard({ policy: { file: ".vendo/policy.json" } })` names a policy document; it is not one. The report sent the knob verbatim, so the console's Policy card showed `{"file":".vendo/policy.json"}` labelled "set in code" and then failed it against the policy schema, which wants a real `vendo/policy@1` document. The pointer is now followed at report time — the path taken exactly as the guard takes it — and the file's own bytes are reported as a file surface. Inline rules, preset names and `profile.policy` are values rather than pointers and still report as code.

- Updated dependencies [aa1c8db]
- Updated dependencies [aa1c8db]
- Updated dependencies [aa1c8db]
- Updated dependencies [aa1c8db]
  - @vendoai/guard@0.25.0
  - @vendoai/harnesses@0.25.0
  - @vendoai/store@0.25.0
  - @vendoai/core@0.25.0
  - @vendoai/agents@0.25.0
  - @vendoai/actions@0.25.0
  - @vendoai/apps@0.25.0
  - @vendoai/automations@0.25.0
  - @vendoai/knowledge@0.25.0
  - @vendoai/mcp@0.25.0
  - @vendoai/ui@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [42b2b78]
- Updated dependencies [b4dd54d]
  - @vendoai/apps@0.24.0
  - @vendoai/ui@0.24.0
  - @vendoai/actions@0.24.0
  - @vendoai/agents@0.24.0
  - @vendoai/automations@0.24.0
  - @vendoai/harnesses@0.24.0
  - @vendoai/mcp@0.24.0
  - @vendoai/store@0.24.0
  - @vendoai/core@0.24.0
  - @vendoai/guard@0.24.0
  - @vendoai/knowledge@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [ef66908]
  - @vendoai/agents@0.23.0
  - @vendoai/actions@0.23.0
  - @vendoai/core@0.23.0
  - @vendoai/store@0.23.0
  - @vendoai/guard@0.23.0
  - @vendoai/apps@0.23.0
  - @vendoai/automations@0.23.0
  - @vendoai/harnesses@0.23.0
  - @vendoai/ui@0.23.0
  - @vendoai/mcp@0.23.0
  - @vendoai/knowledge@0.23.0

## 0.22.0

### Minor Changes

- 90c0de8: Config resolves in code, forever — and the console only ever hears about it.

  Per surface, resolution is now exactly: a value passed in code → the local `.vendo/<name>` file → not set. The console is out of resolution entirely. The hosted-config client that made a console-published value a third rung is deleted, along with every leg that read it: the brief resolver, the theme and design-rules providers, the merged tool semantics, the guard's policy fallback, and the actions registry's cloud overrides-enablement fetch. A deployment's config can no longer change underneath it because someone published in a browser, and a keyed boot no longer makes a blocking config read before it can serve a tool.

  BREAKING. `cloudConfig` and its types (`CloudConfig`, `CloudConfigDoc`, `CloudConfigResult`, `CloudConfigOptions`) are gone from the package root. `ConfigSurfaceOwner` loses its `"cloud"` member, and `SelectConfigSurfaceInput` loses `cloud`. `@vendoai/guard`'s `policyCloudFallback` option is gone — nothing can fill it now. The CLI's `vendo config push` and `vendo config pull` (and the `--draft`, `--yes`, `--key`, `--api-url` flags they carried) are gone; `vendo config status` is local-only, reports `file` / `unset`, and makes no network call and needs no credential. `vendo doctor` no longer downgrades a missing `.vendo` config file to a warning when `VENDO_API_KEY` is set — a missing file is a missing file for every deployment.

  In its place, a keyed runtime REPORTS the config it resolved to, one way and lazily: `PUT /api/v1/config/report` (204 No Content) carrying all five surfaces as `{ source: "file" | "code" | "unset", content }`, pushed through the existing batched uploader on the deployment identity every keyed call already carries. It fires at boot and again only when the resolved surfaces actually change — no heartbeat, no timer, no new transport. Keyless deployments report nothing, ever.

### Patch Changes

- Updated dependencies [90c0de8]
  - @vendoai/guard@0.22.0
  - @vendoai/agents@0.22.0
  - @vendoai/harnesses@0.22.0
  - @vendoai/core@0.22.0
  - @vendoai/store@0.22.0
  - @vendoai/actions@0.22.0
  - @vendoai/apps@0.22.0
  - @vendoai/automations@0.22.0
  - @vendoai/ui@0.22.0
  - @vendoai/mcp@0.22.0
  - @vendoai/knowledge@0.22.0

## 0.21.0

### Minor Changes

- 46aee4a: Host fonts become bytes, not just a name.

  Theme extraction learned that the brand font is called "Inter". That name is
  enough for the host's own pages and useless everywhere else: a generated screen
  renders inside surfaces the host's stylesheet never reaches, where "Inter"
  resolves to whatever the surface happens to have — normally nothing.

  - **`vendo sync` now writes `.vendo/fonts.css`** — the theme's families resolved
    to real files and inlined as data-URI `@font-face` rules. Three sources, in
    order of how much each proves about what the host actually ships: next/font's
    build output, the host's own `@font-face` rules pointing under `public/`, then
    the Google Fonts css2 API. The first and last are re-resolved on every run and
    never recorded — next/font's filenames carry a per-build hash and gstatic's
    carry a font version, so a stored path is a path that rots. Written with
    `theme.json` and only then (install, and any sync where the brand actually
    moved), because resolving a face can reach the network and `sync` runs from
    `predev`. `init` prints the one-line import beside the `<VendoProvider>` paste.
  - **`theme.json` gets metadata, never bytes** — `typography.fonts` names each
    face's family/weight/style/source. The file is a bundle import and rides the
    `?vendoTheme=` query string, where a base64 face would blow past every proxy's
    request-line limit.
  - **A host's real mono font is learned instead of discarded.** The body-stack
    derivation found the mono binding, filtered it out of the sans candidates and
    dropped it, so a host shipping Geist Mono still got the generic system stack.
    It is now derived on its own and stored as `typography.monoFamily`, falling
    back to `monospace` rather than `sans-serif` — a code font that fails to load
    must fall back to another code font.
  - **`VendoProvider` takes a `fonts` string** and the chrome injects it beside
    its own sheet, as a guarded `<style data-vendo-fonts>`. Kept separate from
    `ensureChromeStyles` on purpose: the faces and the chrome are wanted
    independently — a surface rendering inside someone else's client needs the
    faces and none of the chrome.

  - **Sync no longer captures its own output.** The root layout now imports
    `.vendo/fonts.css`, and the seed-baseline style capture would have read that
    sheet straight back in — ~65 KB of base64 copied into every remixable seed and
    host-component bundle, on every run. `.vendo/` is sync's output, never host
    source, and the capture skips it.

  Only latin is taken, and only because both sources already publish per-subset
  files. No glyph-subsetting machinery ships, and there is no license logic.

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

- 6856b4f: The wire format (`app.vendo`) and the plan dialect (`plan.vendo`) are gone. One
  artifact writes a screen now — `app.tsx`, a React component through the sealed
  screen engine — so there is one security model, one execution engine and one
  renderer. The tree stays: it is still the JSON currency the renderer paints.

  Removed from `@vendoai/apps/contract`: `compileWire`, `WireCompileOptions`,
  `WireCompileResult`, `expandInlineRefs`, `InlineRefsResult`, `WIRE_ISSUE_CODES`,
  `WIRE_ADVISORY_ISSUE_CODES`, `isAdvisoryWireIssue`, `WireIssue`, `WireIssueCode`,
  `printWire`, `WirePrintInput`, `WirePrintOptions`, `compilePlan`,
  `PlanCompileResult`, `PlanFacts`, `planTabs`, `PLAN_DISPLAYS`, `AppPlan`,
  `PlanDisplay`, `PlanGroup`, `PlanLeaf`, `PlanQuery`, `PlanServer`, and the
  island-derived-values surface. `checkBindingShapes` and `BindingShapeError` stay
  — they moved to `genui/shape-check.ts` and still serve the screen's
  bindings-fit check. `evaluateExpr` and the brace grammar stay: the renderer
  evaluates them.

  Renamed, because "wire" no longer names anything: `KIT_WIRE_UNSAFE_NAMES` is
  `KIT_NON_SCREEN_NAMES` and `KIT_WIRE_COMPONENT_NAMES` is
  `KIT_SCREEN_COMPONENT_NAMES`. The `WIRE_COMPONENT_NAMES` alias is deleted.

  Removed from `@vendoai/apps`: `skeletonFromPlan`, `checkoutApp`,
  `AppsRuntime.authored` (`authoredScreen` is the screen's counterpart and stays),
  `AppsConfig.escalatedPlan`, `create({plan})`, `RenderSeamOptions.authoredApp`,
  `RenderSeamOptions.facts`, `AppFloor.compile` and `AppFloor.check` — the floor
  has one method, `component()`. `HOT_PATH_FILES` is `["app.tsx"]`, so the render
  seam watches, checks and paints exactly one file. `validateWrittenApps` no longer
  takes a `workspace` and no longer has a `{document}` door — a screen's mechanical
  half already ran as its paint gate, so the gate's one call is `validate({appId})`
  — and the `validate` verb itself takes `{ appId }` only.

  Escalation stays and is re-shaped. The screen agent's `escalate` hand takes one
  plain sentence — why assembly cannot serve this ask — and the builder is handed
  the person's ORIGINAL prompt beside it. Nothing pre-plans the build and nothing
  pre-declares the box's interface. The cost is the instant outline: an escalated
  build now shows a plain building state until the box has something real to show.

  Two consequences of the plan's removal, both visible to a host:

  - A box that reported no interface is now a FAILED create/edit rather than a
    warning. It used to be reported only for a plan that required a served
    surface, because a layer-2 failure still left the plan's skeleton standing —
    and there is no skeleton now, so a silent success would be an empty app
    declared ready.
  - The 2→3 served-surface flip has no trigger left. `<Server served>` was its
    only source, so an app can no longer BECOME a served app; everything about one
    that already is (`ui: "http"`) — the serve door, ping, fork refusal, box-path
    edits — is untouched.

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

### Patch Changes

- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [7eecc29]
- Updated dependencies [6856b4f]
- Updated dependencies [6fd3bfa]
- Updated dependencies [46aee4a]
- Updated dependencies [83aec51]
- Updated dependencies [01e225c]
- Updated dependencies [0c27a89]
- Updated dependencies [d9b7c8d]
- Updated dependencies [5932631]
- Updated dependencies [89f2843]
- Updated dependencies [491a2fa]
- Updated dependencies [6856b4f]
- Updated dependencies [6856b4f]
- Updated dependencies [37ed821]
- Updated dependencies [6856b4f]
- Updated dependencies [730ac8f]
- Updated dependencies [2285394]
  - @vendoai/apps@0.21.0
  - @vendoai/core@0.21.0
  - @vendoai/ui@0.21.0
  - @vendoai/actions@0.21.0
  - @vendoai/harnesses@0.21.0
  - @vendoai/mcp@0.21.0
  - @vendoai/store@0.21.0
  - @vendoai/agents@0.21.0
  - @vendoai/automations@0.21.0
  - @vendoai/guard@0.21.0
  - @vendoai/knowledge@0.21.0

## 0.20.0

### Patch Changes

- Updated dependencies [095f143]
- Updated dependencies [7fcf60b]
- Updated dependencies [cfd4f48]
  - @vendoai/core@0.20.0
  - @vendoai/store@0.20.0
  - @vendoai/actions@0.20.0
  - @vendoai/agents@0.20.0
  - @vendoai/apps@0.20.0
  - @vendoai/automations@0.20.0
  - @vendoai/guard@0.20.0
  - @vendoai/harnesses@0.20.0
  - @vendoai/knowledge@0.20.0
  - @vendoai/mcp@0.20.0
  - @vendoai/ui@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [2879e46]
- Updated dependencies [cb2d68e]
- Updated dependencies [39a1c78]
- Updated dependencies [5f4d694]
  - @vendoai/core@0.19.0
  - @vendoai/store@0.19.0
  - @vendoai/actions@0.19.0
  - @vendoai/agents@0.19.0
  - @vendoai/apps@0.19.0
  - @vendoai/automations@0.19.0
  - @vendoai/guard@0.19.0
  - @vendoai/harnesses@0.19.0
  - @vendoai/knowledge@0.19.0
  - @vendoai/mcp@0.19.0
  - @vendoai/ui@0.19.0

## 0.18.0

### Minor Changes

- 88ec7e6: Appending a message to a hosted thread stops downloading the whole conversation first. The wire had no verb that carried an owner, so the client read `data.subject` off the thread record before it could write — a turn paid that read several times, and the payload grew with the conversation forever, while the SQL half had always done the same work in one statement. `transcripts.appendMessages` is the additive 36th op (body `{threadId, subject, messages, title?}`, answer `{revision, count}`, deliberately NOT the thread — echoing the transcript back would reintroduce exactly the payload the op removes), `StoreOps.appendMessages` is its optional client method, and a turn's changed messages now go out as ONE `upsertMany`. `Thread.revision` is carried from the read so persist compare-and-swaps on it instead of re-reading, and persist runs only when the row must be created — every later turn is a pure append, title and all.

  A console that predates the op is served by an explicit capability feature-detect (the `/status` op count, the wire's own discovery handshake) asked once per StoreOps handle and cached, which routes to the older getThread + putMessage path. It is a supported route chosen BEFORE the write, never a catch-and-degrade around a failed mutation (#1251), and the count is a proxy for capability only while ops are ONLY EVER ADDED — remove one while adding another and a mount reaches 36 without serving this op, which is named in the comment for whoever adds op 37.

  Every transcript writer now takes the thread row BEFORE allocating a `seq`. `seq` carries conversation order and has no unique constraint, so equal seqs make the transcript read back ordered by message id — scrambled. Two concurrent writers used to read `max(seq) + 1` from their own READ COMMITTED snapshots before anything held a lock: on real PostgreSQL 17.11, 20 rounds of each pairing collided 19–20 times out of 20. `touchThread` runs first in `appendMessages`, `putMessage` and `recordAnswer` alike, so the loser blocks on the thread row until the winner COMMITs and allocates on a snapshot that already holds its rows; `upsertMany` and `appendThreadMessages` therefore take NO caller seq, because a position computed outside the transaction cannot be made safe. One lock order everywhere also means none of these writers can deadlock against another. The race test runs all three pairings on the postgres leg — PGlite is one connection and nothing interleaves, so it can never catch this.

### Patch Changes

- Updated dependencies [88ec7e6]
- Updated dependencies [88ec7e6]
  - @vendoai/core@0.18.0
  - @vendoai/store@0.18.0
  - @vendoai/harnesses@0.18.0
  - @vendoai/guard@0.18.0
  - @vendoai/actions@0.18.0
  - @vendoai/agents@0.18.0
  - @vendoai/apps@0.18.0
  - @vendoai/automations@0.18.0
  - @vendoai/knowledge@0.18.0
  - @vendoai/mcp@0.18.0
  - @vendoai/ui@0.18.0

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

- 8af9e4c: A deployment's users can use the product over text message. `createVendo({ channels: { text: true } })` plus one anchor to `/api/vendo/channels/text/link` is the whole opt-in: a signed-in user opens the anchor, their phone jumps into a prefilled first message, and from then on they text the agent, which acts as them exactly as it does in a web chat — same guard, same threads, same audit. Linking takes two texts because the identity router that binds the phone consumes the first one, so the link page says so and the code is short and unambiguous enough to retype. The phone ↔ user binding lives in the deployment's own store (`vendo_channel_links`, swept by `erase.bySubject`); Vendo Cloud carries the numbers and the delivery and never learns who a phone belongs to. A gated tool call parks as usual and the consent card becomes a text carrying the exact action and arguments — "YES" from the linked phone decides the same approval record the turn is blocked on, so an approval wait is now a per-turn bound (10 minutes on a channel turn, the frozen 90 seconds everywhere else).

### Patch Changes

- d1de477: next-auth v4 hosts fail loud and correct instead of silently breaking: the
  authJs preset resolves `AUTH_SECRET` then v4's `NEXTAUTH_SECRET` (Auth.js's
  own legacy order), defers module/secret work until an Auth.js session cookie
  is actually present (a misconfigured preset no longer 501s anonymous
  traffic), and names next-auth v4 once when it sees a v4 session cookie.
  `vendo init` prints a v4 advisory when wiring authJs onto a major-4 host.
  The wire surfaces a failed principal resolver's own message instead of a
  generic Internal Vendo error. Doctor distinguishes a declined actAs mint
  (new E-AUTH-008 warning) from an unconfigured seam (E-AUTH-007), passes the
  wire's failure reason through E-AUTH-004, and its act-as pass message stops
  claiming host verification the probe never performs.
- 0e29c39: A `package.json` saved with a UTF-8 BOM — what Notepad and PowerShell's `Set-Content` produce — no longer crashes `vendo init` with a raw SyntaxError: the CLI strips a leading BOM everywhere it reads host files (the shared `readOptional`, framework detection, doctor's dependency check, dep-version telemetry, and MCP server.json identity), matching how npm and Node's own `require()` treat the same file. A genuinely malformed `package.json` now fails with one clean sentence — `vendo init: package.json is not valid JSON (…) — fix it and re-run vendo init` — instead of a stack dump.
- 54309b4: A development process fires its own scheduled automations. Two gaps compounded into armed-and-never-fired schedules on every local deployment: under the hosted store the composition deferred schedule/external firing to Cloud's scheduler unconditionally — but Cloud cannot reach a dev server (a localhost wire is in no deployment inventory), so nobody fired; and even self-hosted, the local tick is an external caller's job (`POST /tick` with `VENDO_TICK_SECRET`) that no laptop has. Now a development composition keeps schedule firing local (the schedule-cursor claims are atomic in the shared store, so a second firer can never double-run a tick) and arms the engine's own minute ticker from the ready() latch — the same Workers-safe arming the background sweep uses, unref'd so it never keeps a dev server from exiting. Deployed processes are unchanged: hosted deploys leave firing to Cloud, self-hosted production still uses the external tick caller. The hosted-store boot notice tells the development story honestly.
- ea830ec: Three doctor honesty fixes for real-world deployments. Console-managed deployments stop failing E-CFG-001: with `VENDO_API_KEY` set, a missing cloud-resolvable surface (`brief.md`, `policy.json`, `theme.json`, `overrides.json`) is a warning pointing at `vendo config status` — those surfaces legitimately live as published config (`tools.json` stays fatal; keyless behavior is unchanged). E-LIVE-001 now carries what actually came back from `/status` — the wire's own `error.code`/`error.message` plus a dev-server-log hint — and an answered non-JSON error page is reported as E-LIVE-001 with its HTTP status instead of being mislabeled "unreachable" (E-LIVE-002 is reserved for a fetch that never answered). And every `fix_ref` URL now points at `docs.vendo.run/agents/verify`, which serves the playbook directly instead of a redirect some agent HTTP clients refuse.
- c875814: Two field-outage guards. The development automations ticker is now one per process, adopted by the newest composition — Next dev re-evaluates route modules on every recompile, and each orphaned composition kept its minute-ticker alive, grinding the hosted store into rate limits on long dev sessions (#1250). Arming stops the predecessor's interval and starts the newcomer's, so exactly one ticker runs and it belongs to the composition actually serving requests (the slot rides `Symbol.for` on globalThis so it survives module churn). And the hosted store now names version skew instead of failing silently: when the console answers "Unknown store operation" for an op this client shipped with, the error says the real cause — this @vendoai/vendo is older than the console, update the package — and one loud log line reaches the server operator (#1251); previously every store-backed route just 501'd with nothing in the log.
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

- 408b791: `vendo init`'s provider auto-install now runs on Windows — the spawn goes through the platform shell (package managers are `.cmd` shims there) with every arg quoted so caret-bearing specs like `ai@^6` survive cmd.exe — and a failed install's warning carries the installer's own stderr tail instead of a bare "could not install". A resolvable pre-v6 `ai` (typically another package's workspace-hoisted copy) is now a floor violation rather than a satisfied dependency: init installs `ai@^6` over it, and `vendo doctor` fails E-DEP-001 naming your package manager's exact upgrade command and the workspace-hoist story instead of passing green into runtime 500s.
- 8ded5cc: The automation ask stops falling into the two-step trap. The `schedule` verb's words matched its behavior nowhere: titled "Set when this runs" and described as "Set or change … what you are arming", it taught calling agents to build a view with `vendo_make` and then arm it here — but the verb only re-times an EXISTING automation, so the ask died with a refusal and no automation was ever authored (field: every scheduled-task ask on the linkwarden baseline). Now the verb says the one thing it does — retitled "Change when this runs", described as never creating, naming `vendo_make` (this app in `app`, schedule and action in one request) as the authoring door — and the no-trigger refusal carries the same exact next move so a mid-turn agent can recover. The screen agent's escalate door also names away work explicitly ("any part that must run while nobody is watching — a schedule, a product event — … escalate the WHOLE ask"), closing the gap where its skill taught the `<Server>` declaration but the door's own text listed only real-code reasons to leave, so a schedule ask got assembled as a plain view with no trigger. The MCP app shim is regenerated for the retitle.
- Updated dependencies [c17d492]
- Updated dependencies [64004b6]
- Updated dependencies [d1de477]
- Updated dependencies [85fc732]
- Updated dependencies [729dd3e]
- Updated dependencies [54309b4]
- Updated dependencies [9ea21ef]
- Updated dependencies [1865bdd]
- Updated dependencies [565caf0]
- Updated dependencies [c79866f]
- Updated dependencies [c8ce625]
- Updated dependencies [8ded5cc]
- Updated dependencies [8af9e4c]
- Updated dependencies [65e82e7]
  - @vendoai/core@0.17.0
  - @vendoai/apps@0.17.0
  - @vendoai/ui@0.17.0
  - @vendoai/guard@0.17.0
  - @vendoai/automations@0.17.0
  - @vendoai/actions@0.17.0
  - @vendoai/harnesses@0.17.0
  - @vendoai/mcp@0.17.0
  - @vendoai/agents@0.17.0
  - @vendoai/knowledge@0.17.0
  - @vendoai/store@0.17.0

## 0.16.0

### Minor Changes

- d529cf8: The make receipt says `"partial"` when the server work did not get built.

  A create whose server lane failed already told the person the truth in words —
  "I built the screen, but the server-side part didn't get built" — and still
  handed back `status: "ready"`. So the sentence was honest and the FIELD was not:
  everything that branches on `status` rather than reading `say` — a host's own
  `if`, the pack's ref capture, an outside agent over MCP — saw a clean build of a
  half-built app. That is the original silent-success bug one field over.

  `MakeReceipt.status` gains `"partial"`: the screen is painted and on the person's
  page, and the server work its plan required is not. It is deliberately not
  `"failed"`, which means nothing was painted and sends an agent to rebuild — this
  view is real, reopenable, and still narrates through its own card. Hosts that
  switch on `status` should treat `"partial"` as a success with a named gap; hosts
  that only relay `say` are unaffected.

  The tool pack's ref capture refuses it for the same reason it already refuses a
  failed edit: `vendo/app-ref@1` is `{ kind, appId, title, status: "building" }`
  and carries neither `status` nor `say`, so laundering a partial build through it
  left a BYO loop — and `vendo_delegate`'s `refs` — waiting on a completion that
  already came, with no sentence saying what was missing. It now falls back to the
  receipt itself, both fields intact.

### Patch Changes

- Updated dependencies [d529cf8]
- Updated dependencies [795f8c1]
  - @vendoai/apps@0.16.0
  - @vendoai/actions@0.16.0
  - @vendoai/agents@0.16.0
  - @vendoai/automations@0.16.0
  - @vendoai/mcp@0.16.0
  - @vendoai/store@0.16.0
  - @vendoai/ui@0.16.0
  - @vendoai/core@0.16.0
  - @vendoai/guard@0.16.0
  - @vendoai/harnesses@0.16.0
  - @vendoai/knowledge@0.16.0

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
