# @vendoai/ui

## 0.7.0

### Minor Changes

- ea3cb0b: A pin now has a payoff. Pinning a generated view used to be silent: the panel
  stayed open over the page, and the slot showed the app whenever its next ≤5s
  poll happened to fire — nothing connected the click to the result.

  Every pin affordance (the in-thread card bar and the workspace stage) now runs
  one sequence, graduated from the Keystone demo:

  1. the panel dismisses first, because the payoff is on the page and the card
     being pinned sits in a modal over a scrim;
  2. a ghost of the card flies into the slot (300ms) and the slot takes a settle
     pulse (180ms) — 480ms total, deterministic, and the slot is scrolled into
     view first so the landing is actually watchable;
  3. the slot re-reads on the pin event instead of waiting for the poll tick.

  `prefers-reduced-motion` keeps the dismiss and the pulse and skips the flight.
  The ceremony is presentation only — the pin is still whatever the host's
  `onPin` writes — so a slot that is not mounted means no animation rather than a
  stranded ghost.

  New public surface, all optional:

  - `usePinAction()` (`@vendoai/ui/chrome`) — what the built-in affordances call.
  - `playPinCeremony({ appId, slot, dismiss })` — the same sequence for a host
    running a pin from its own control.
  - `announcePin(appId)` / `onPinAnnounced(listener)` (`@vendoai/ui`) — the bus
    `useSlotApp` listens on, for hosts that pin outside a Vendo surface.
  - `pinSlot` on `VendoRoot`/`VendoProvider` — the ceremony's destination. Only
    needed by hosts mounting several slots; with one, the ceremony finds it.

- 37ec12a: New `Remixable` chrome component: wrap any host element to mark it remixable.
  At rest a small muted ✦ sits in the element's top-right corner; hovering (or
  tabbing into) the element blooms it in place into a **✦ Remix** pill, held open
  for a 200ms grace so the cursor can travel to it. Clicking opens the
  conversation surface EMPTY with the element attached — a `Remixing · <name>`
  chip in the panel chrome that rides with the next message and clears on send —
  so the pill can never fire a turn on its own. Under `prefers-reduced-motion`
  the bloom snaps.

  ```tsx
  <Remixable name="Rent Roll">
    <RentRollTable units={units} />
  </Remixable>
  ```

  `name` is the surface in the host's own words (the chip's label, and what the
  agent is told); the optional `context` is one grounding line appended after the
  user's message, exactly like `VendoTrigger`'s. Hosts wiring their own element
  call `openVendoConversation({ remix: { name, context } })` — the same registry
  seam, now carrying an attachment alongside a prompt.

  Distinct from `VendoSlot`'s `remix` flag, which forks the component pinned in
  that slot; `Remixable` attaches any element to the next ask and forks nothing.

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

- dd73974: Three fixes the Keystone demo build turned up.

  **ConnectCard hangs on "Connecting…" under React StrictMode.** The card's
  cancel ref was only ever SET (by the effect's cleanup) and never reset on
  setup, so dev-mode's mount → cleanup → re-mount latched it before the user
  ever clicked: `completeConnection`'s poll loop saw "cancelled" on its first
  check, returned without throwing, and the card sat on the spinner forever.
  It now resets on setup, exactly like its sibling `ConnectedAccountsPanel`
  already did. Hosts no longer need `reactStrictMode: false` to demo a connect.

  **The composer centred its own text past one line.** `.fl-composer-row` was
  `align-items: flex-end`, which is right for a one-line field and wrong for
  every other: a textarea's text sits at ITS top, so as the field grew the row
  pushed the icons and Send DOWN while the text stayed put — the input read as
  mis-centred and Send moved under the cursor mid-sentence. The row is now
  top-anchored, so the field grows downward and the controls hold still. At one
  line the icon's 34px box and the text's 33px line box agree, so the collapsed
  composer is unchanged.

  **A single failed `apps.open` skeletoned a pinned app forever.** `useApp`
  recorded the error and every mounted surface kept rendering "Loading app…"
  until a full page reload. The load now retries three times with backoff
  (300ms, 600ms), and a load that really is dead renders a terminal state with
  a "Try again" button — in `VendoSlot` and in `VendoPage`'s app pane.

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

- 9532dc0: A turn that builds nothing no longer looks like it is building something.

  Between send and the first streamed chunk the thread painted a document-shaped
  skeleton card under a "Generating…" label. That window has no idea yet whether
  the turn will produce a view: on the live demos it showed on every turn, then
  resolved into plain prose or a refusal, which read as a generated view that had
  failed to arrive.

  The pre-first-chunk window now uses the same quiet liveness indicator every
  other waiting moment in a turn already uses, so the transcript promises nothing
  it may not deliver. Nothing changed about how a real build narrates: tool calls
  still speak through the status ribbon, and a forming generated view still shows
  "Building your view…" on the app card until it settles.

  `.fl-generating` and the `.fl-skeleton` card are removed from the chrome
  stylesheet (`.fl-skeleton-bar` stays — the markdown table's forming row uses
  it). The internal `MessageList` no longer takes `awaitingFirstChunk`.

- d6c231e: One visitor, one anonymous identity — consent-gated actions stop failing silently.

  An anonymous visitor's identity IS the opaque session pointer the door mints on a
  cookie-less wire request, and the door mints one PER REQUEST. A cold page load
  mounts several hooks at once (`/status`, `/approvals`, `/automations`,
  `/activity`, `/connections/catalog`, `/connections`), so every one of them left
  cookie-less and minted its own subject; the browser's jar kept whichever
  `Set-Cookie` landed last and the rest were orphaned. Measured live: one page load
  produced four distinct subjects, three orphaned.

  The damage lands on the trust mechanism at the centre of the product. An agent
  run created its consent approval under one subject, the user's Approve arrived as
  another, and guard correctly refused another subject's approval — surfacing as
  `Approval apr_… was not found` and a run stuck on "waiting for your approval"
  forever. Every consent-gated action failed this way, and the same split emptied
  the activity feed mid-run.

  The browser is the visitor boundary, so `createVendoClient` is the layer that can
  close the race honestly: the first request through a client may leave
  cookie-less, and every request issued before it answers now waits for it and
  travels with the pointer it established. Costs one extra round trip on a cold
  load and nothing afterwards; a failed first request releases the gate rather than
  holding it, so the old behaviour is the floor, never something worse.

  Deliberately NOT solved by fingerprinting the requester (IP/User-Agent would
  merge two real visitors behind one NAT into a single session, sharing threads,
  grants and approvals) nor by deriving the pointer from request attributes (that
  would make a live session guessable, where today it is a 2^128 search). Hosts
  that already mint the pointer on their document response keep working unchanged —
  the door treats a pre-established pointer as canonical.

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

- d1364b6: Chrome wave: split-view workspace with morphing stage, compact embeds, staged blur, stage pinning (host onPin seam), AutomationCard, ConnectCard lifecycle states, landing composer, docked new-reply banner, streaming skeletons, WorkingRibbon, connect-dock resilience, ApprovalSheet fixes, approvals-decided resume event, and eventOutcomeLabel stream-part semantics.

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

- fd9260d: Empty-states batch — a fresh install's FIRST generated app now renders well
  with no bindable host data. Generation always emits the requested component
  bound to its tool (the Kit renders the designed empty state) instead of
  omitting it or writing prose into a tile; the no-data explanation is one
  consolidated "About this view" note, charts route to the Kit, and the app
  name is a <=40-char display title (validated on create) instead of the
  request echoed back. The Kit stat tile shows a compact em dash for empty
  values and truncates prose-length text into a tooltip, empty label/value
  pairs render an em dash, and the in-thread app panel scrolls its top into
  view when a live build settles. The create-app tool description also stops
  callers baking pre-computed figures or branding into the prompt.
  - @vendoai/core@0.4.7

## 0.4.6

### Patch Changes

- 60c5e39: A create_app build can no longer die silently (0.4.5 E2E cert defect D, byo-ai-sdk host). Three layers: a build whose every region was disclaimed away ("This part of the request isn't available on this host.") now fails terminally with an honest host-capability reason instead of persisting as a "successful" app that reads as a build hanging forever; a server-side build watchdog persists a terminal failed record when a build task neither completes nor throws inside its window (VENDO_APP_BUILD_WATCHDOG_MS, default 4 min), so the embed always resolves even if the build promise hangs or is severed by the host runtime; and the embed's build deadline is now an absolute client-side timer with a per-poll timeout, so a hung open() poll can no longer freeze the building beat past the deadline.
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
- a7d57b7: Composer upgrades (ENG-215): the message textarea now autogrows with its content
  (caps at max-height, then scrolls); typing is never blocked while a turn streams;
  a message sent mid-turn visibly queues and auto-sends the moment the turn
  completes (Stop stays the explicit interrupt). Adds Edit on the last user turn
  (refills the composer and drops the turn so re-sending amends rather than
  duplicates) and Regenerate on the last assistant turn. Fixes the focus dump to
  `<body>` that used to break Escape and the overlay focus trap when the composer
  disabled mid-turn. `useVendoThread` now exposes `setMessages` for headless parity.
- e9c538c: Tool & approval humanization (ENG-216): add an additive, UI-side host-metadata
  seam (`VendoProvider` `tools` prop — friendly labels, descriptions, and custom
  arg summarizers per tool) with a formatting fallback that prettifies raw tool
  ids and formats args into readable summaries. Tool chips no longer show the raw
  slug or the ai-SDK lifecycle string, consecutive identical tool chips collapse
  into one entry with a count, and the in-thread `ApprovalCard` no longer
  fabricates or displays a context byline (the queue path keeps its real
  server-provided `ctx`). No contract or wire changes.
- da4d3e8: Extreme-content solidity (ENG-218): the thread stays smooth no matter how long
  the transcript or how large a single message. Long threads are windowed — only a
  bounded trailing slice of turns is in the DOM, with a "Show N earlier messages"
  control that reveals the deferred head in chunks and anchors the viewport so the
  reader is never yanked. Entrance animations are gated on restore, so reopening a
  200-turn thread no longer fires every `fl-item-in` rise at once. Markdown is
  memoized so a streaming turn only re-parses the block that changed instead of
  re-parsing every settled turn per token, and a restored huge message (pasted
  logs, model dumps) collapses behind a "Show full message" expander that bounds
  both parse time and node count. Raw tool-payload previews in the approval card
  are likewise capped. Stick-to-bottom and jump-to-latest are preserved under all
  of the above.
- a2ca8e2: Palette + Page fixes (ENG-222). `VendoPalette`'s keybinding is now a
  host-collision-safe singleton: one shared listener no matter how many palettes
  mount (no more double-toggle across mounts), a configurable `hotkey` prop
  (a chord like `{ key: "k", meta: true }`, a custom matcher function, or `false`
  to disable the keyboard opener entirely), and it no longer steals a keystroke
  from a focused host input while closed. `VendoThread` gains an optional
  `onThreadId` callback that fires with the effective (possibly server-minted)
  thread id. `VendoPage`'s chat sidebar now refreshes when a conversation started
  via "New conversation" mints its thread, so the new conversation appears (and
  highlights) instead of never showing; an explicit selection also survives a
  background list refresh.
- b819ab2: Slot: wire the empty-state CTA + pinned-component placement path (ENG-223).
  `VendoSlot`'s empty state is now a real, focusable `<button>` (was a
  non-interactive div): activating it opens the authoring surface via the new
  optional `onAuthor(slotId)` prop, and — when no handler is supplied — opens a
  mounted `VendoPalette` through the new `openVendoPalette()` singleton opener
  (host-collision-safe like the keybinding; a no-op when no palette is mounted).
  `VendoSlot` also gains a `pin` prop for the "or a pinned component" path in
  08-ui §4: a pinned `vendo-genui/v1` view (`{ payload, data?, onAction? }`)
  now mounts in place through the tree renderer and the PinMount error boundary,
  falling back to the host's original children if it throws — previously a slot
  could only mount a whole app, so hosts pinning a generated component had to
  bypass `VendoSlot` with a bare `AppFrame` (no fallback). The Cadence demo hero
  slot is switched to this path.
- 75cb256: Activity panel rebuild (ENG-224): the self-scoped activity surface now renders
  real semantics instead of a raw data dump. Each row is a concrete action taken
  as the user — a kind badge (Tool, Approval, Connection, …) plus a humanized
  action label (host tool metadata wins, else the prettified slug, never a raw
  id), a plain-language result (Succeeded / Failed / Awaiting approval / Blocked /
  Connect required / Running) with a status glyph, and a human, timezone-stable
  timestamp ("Jul 11, 2026, 12:00 PM") in place of the raw ISO instant. Pagination
  now ends in an explicit end-of-list marker: `useActivity` exposes `hasMore`, which
  flips to `false` once a page adds no new events, so "Load more" retires instead of
  re-fetching nothing. No contract or wire changes.
- 5093682: Implement the full dead-CSS affordance set (ENG-225): copy actions on every
  settled turn, code-block copy, drag-drop attach with image preview chips and
  sent-attachment rendering in the transcript, the waiting-on-you approval queue
  (mounted in VendoPage chat, exported as `WaitingQueue`), the `VendoToasts`
  delivery surface with an imperative `vendoToast()` API and opt-in
  approval-required toasts, and the connect dock + liquid tray in the composer
  (new optional `connectors` catalog on `VendoProvider`; `ConnectCard`'s
  initiate → OAuth → poll flow is now the shared `completeConnection`).
- 083a3b9: Voice v1, the full designed stage (ENG-229): resilient realtime driver
  (connect timeout, bounded reconnect with fresh re-dial, mute via track.enabled,
  live amplitude, humanized failure messages) and the rebuilt `VendoStage` —
  amplitude-driven blob, two-row sticky captions, transcript drawer, consent bar
  (approvals decidable mid-call, with receipts), renderer-backed session-view
  feed with slide focus + dots, reconnecting/error banners with Retry, and exit
  settle choreography (`onSessionEnd`). `useVoice()` additionally returns
  `error`, `muted`, `setMuted`, `amplitude`, and `views`.
- 0f17f39: Voice live pipeline — the realtime tool-call bridge (ENG-319). The realtime
  driver gains an optional `act: VoiceToolBridge`: its `tools` ride the provider
  `session.update` and every model function call funnels through `onToolCall`,
  whose resolved value returns to the model as the function output. The shipped
  `createVoiceActBridge({ client })` exposes one `vendo_act` tool that runs a REAL
  guarded agent turn per call over `POST /threads` — minted views stream into the
  stage feed via `VoiceActSession.emitView`, parked guard approvals reach the
  stage consent bar (ENG-229), and the turn resumes through the existing
  assistant-upsert approval-response path with the guard authoritative over
  execution. No new server surface, no wire change; Maple's voice driver is wired
  to it. Additive 08-ui amendment parked for Yousef sign-off.
- ff6b5d5: Principals + orgs (ENG-263). Anonymous→signed-in auto-merge: the first authenticated request carrying a valid anon cookie adopts the session's threads/apps/state into the real subject and retires the cookie — idempotently, without ever overwriting an existing row; grants, approvals, and connected accounts deliberately do not migrate (consent doesn't transfer identities). Away re-verification rides actAs: the host declining to mint fails the run closed, and every actAs-authenticated call audits its disposition (`detail.actAs`). Runtime-minted subjects move into the reserved `vendo:` namespace (`vendo:webhook:<source>`); host principal resolvers producing reserved subjects (or org-kind principals) are rejected loudly. `kind:"org"` and the `vendo:org:<id>` subject shape remain reserved but inert — no org storage, management surface, or activation ships in this release.
- 0c10661: Add the Kit (`@vendoai/ui/kit`): 31 smart, host-brand-native, generative-UI components — a strict superset of Crayon/Tambo/json-render/Tremor surfaces. Layout, a semantic value tier (Money takes integer cents, dates/percent/num Intl-formatted, `$NaN`/`Invalid Date` unrenderable), a TanStack-Table DataTable (sort/filter/search/paginate/dot-path columns/per-column format/named-query empty state), recharts charts (Line/Bar/Donut/Sparkline/Progress with designed empty/invalid states), forms (Select over raw object arrays, action-gated Button, first-class Disclaimer), and self-managing Tabs/Callout/Accordion. Every prop is zod-schema'd and classed `config | copy | data`; `kitPrompt()` renders the model-facing prompt from those schemas. The existing prewired set is unchanged.

### Patch Changes

- 51f3fc9: Fix (ENG-353): heartbeat-armed idle-abort fallback for client disconnects the runtime never surfaces. Under `next dev` a real browser's graceful tab-close/navigate-away fires neither `request.signal` nor a stream cancel, so an abandoned turn ran to completion and burned provider tokens. The panel now beats `POST /threads/:id/heartbeat` while a turn streams; the first beat arms a server-side idle watchdog that aborts the turn through the same controller as the fast path after ~15s of silence. The fetch-abort fast path is unchanged, and consumers that never beat (curl/scripted clients) keep exact run-to-completion semantics.
- Updated dependencies [49e9ccc]
- Updated dependencies [0032a67]
- Updated dependencies [b6def0f]
- Updated dependencies [4b8ac66]
- Updated dependencies [fa0ad98]
- Updated dependencies [51f3fc9]
- Updated dependencies [ff6b5d5]
  - @vendoai/core@0.4.0
