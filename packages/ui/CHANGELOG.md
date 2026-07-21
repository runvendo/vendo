# @vendoai/ui

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
