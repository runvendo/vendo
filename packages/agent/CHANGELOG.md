# @vendoai/agent

## 1.0.0

### Major Changes

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

### Minor Changes

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

### Patch Changes

- Updated dependencies [1572060]
- Updated dependencies [3f98372]
- Updated dependencies [21c8b10]
- Updated dependencies [1bb535b]
- Updated dependencies [8d623ec]
- Updated dependencies [a004031]
- Updated dependencies [2722d81]
- Updated dependencies [f884bfe]
- Updated dependencies [56e0cc3]
- Updated dependencies [a5293af]
- Updated dependencies [b022eb3]
- Updated dependencies [c9df3f7]
- Updated dependencies [6eb8a04]
- Updated dependencies [215bfcc]
- Updated dependencies [fbf265b]
- Updated dependencies [2ed91b0]
- Updated dependencies [e6aaa7a]
- Updated dependencies [d0c3cc9]
- Updated dependencies [0197470]
- Updated dependencies [38dd824]
- Updated dependencies [798b618]
- Updated dependencies [10a2b44]
- Updated dependencies [98eba22]
- Updated dependencies [14e8246]
- Updated dependencies [fbf265b]
- Updated dependencies [38a840d]
- Updated dependencies [a0dbfc6]
  - @vendoai/harnesses@1.0.0
  - @vendoai/core@1.0.0

## 0.7.0

### Minor Changes

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

### Patch Changes

- bcf8699: Turn-error notices now appear only when the turn actually failed, and never
  outlive the failure.

  Three fixes to the `data-vendo-turn-error` part shipped alongside it:

  **Recoverable tool errors are not turn failures.** The notice was written from
  `toUIMessageStream`'s `onError`, which is the ai-SDK's general error-TEXT
  formatter — it also runs for the `tool-input-error` and `tool-output-error`
  chunks a hallucinated tool name or a throwing tool produces. The SDK feeds those
  back and the model routinely answers on the next step, so a turn that finished
  fine persisted permanent failed-beat alerts above its own answer. The notice is
  now tapped off the merged stream's fatal `error` chunk instead, and is
  once-guarded — the SDK runs the gate a second time over its own error text while
  assembling the message to persist.

  **A retry no longer inherits the failed turn's notice.** When a thread's last
  message is an assistant turn the SDK CONTINUES it, reusing its id and its parts,
  so the flagship keyless → `vendo login` → Retry flow appended the real answer
  underneath the stale "no model key" line and persisted both — wrong on every
  reload, forever. A new turn now clears the trailing turn's notice; anything that
  turn really produced (partial text, tool beats) stays, and a turn left with
  nothing else is dropped so the reply starts clean.

  **Failures thrown before the model stream exists are recorded too.** Tool
  building, `descriptors()`, and history conversion fail before any model chunk
  exists, so those turns still persisted blank — the exact defect the part was
  added to end. They now carry the same gated string, making good the previous
  changeset's claim that the thread never shows a blank reply.

- Updated dependencies [8f5a7c0]
  - @vendoai/core@0.7.0

## 0.6.1

### Patch Changes

- @vendoai/core@0.6.1

## 0.6.0

### Minor Changes

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

- Updated dependencies [89153f8]
- Updated dependencies [3ae3d13]
  - @vendoai/core@0.6.0

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

- f95feb7: Runtime/generation wave: `apps.pipeline` threading through createVendo, `agent.instructions` host-voice seam, per-instance judge model binding (bindVendoModelSlots — the process-level slot registry is gone; `Judge.model` is now part of the guard's Judge contract), island-scoped repair + concurrent tier-0 paint lane with a monotonic partial gate, region-parallel assembly compiling the production inline-reference dialect, smoke-render environment failures skipping instead of failing apps, no-emoji contract rules, and per-lane generation logging (onTiming/onPipeline wired to the operator console).

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

- Updated dependencies [31f899e]
  - @vendoai/core@0.4.5

## 0.4.4

### Patch Changes

- 89e3d2b: Mid-stream turn errors are no longer a dead end: the agent logs the real
  error server-side ("[vendo] turn stream error") and passes its OWN safe
  errors (VendoError code + message) to the wire recognizably prefixed, while
  raw provider/transport strings stay the fixed generic text. The thread
  error banner renders that safe detail line (code included) next to Retry —
  "Something went wrong" alone is now reserved for errors we genuinely can't
  say more about.
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

- 0032a67: Add optional atomic record claims and revision CAS, use them to deduplicate multi-instance automation firing, and abort in-process agentic runs when stopped.
- 4b8ac66: Per-user connected accounts via the Composio broker (ENG-262). Connectors gain a subject-scoped `connections` capability (list/initiate/status/disconnect); the umbrella serves per-principal `/connections` endpoints with a Vendo Cloud broker seam behind `VENDO_API_KEY`; a Composio call missing a connection returns the new typed `connect-required` tool outcome, rendered by `VendoThread` as an inline connect card that retries after connecting; `ConnectedAccountsPanel` (list + disconnect) joins the chrome as the accounts tab. Composio tools carry curated risk (metadata hints + slug patterns) instead of a blanket `write`; the MCP connector accepts an async per-principal `headers` resolver with per-subject sessions; every connector execution is audited with its account identity.
- ebc72e4: Runtime tool search and loadout (ENG-252). Add a deterministic `ActionsRegistry.search` query API (plus the pure `searchToolDescriptors`) that ranks the merged, enabled tool surface by intent, excluding disabled tools. The agent gains a `vendo_tools_search` meta-tool: it starts from a bounded initial loadout — the whole enabled surface when it fits the cap, an explicit curated list when provided, otherwise a read-first bounded default (`DEFAULT_MAX_INITIAL_TOOLS`) — and discovers and loads the rest mid-run. Loaded tools persist across turns within a thread and execute through the same guard-bound registry as any initially-enabled tool, so there is no unguarded path. The umbrella wires the search seam to the guard-bound registry.

### Patch Changes

- b6def0f: Capture capability misses from embedded agent runs in a local JSONL sink and,
  when a Cloud API key and telemetry consent are present, upload them in bounded
  best-effort batches with the canonical enabled-tool surface.
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

- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.
- Updated dependencies [49e9ccc]
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [fa0ad98]
- Updated dependencies [51f3fc9]
- Updated dependencies [ff6b5d5]
  - @vendoai/core@0.4.0
