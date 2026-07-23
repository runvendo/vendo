# @vendoai/ui

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
