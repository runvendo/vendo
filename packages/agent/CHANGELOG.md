# @vendoai/agent

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
