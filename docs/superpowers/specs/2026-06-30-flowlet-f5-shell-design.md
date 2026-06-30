# Flowlet F5 - Product surface / shell (ENG-182)

## Overview

F5 is the native Flowlet shell: the product surface where the agentic experience
lives inside a host app. It consumes the F1 foundation (the `ai` SDK UIMessage
stream, the component registry, `useFlowletChat`) and renders streamed text, UI
nodes, approvals, and integrations into three drop-in elements. It is built
against the F1 stub renderer now and swaps in the F3 sandbox renderer later behind
a stable seam.

This is pure Flowlet product. No demo-specific or host-specific content lives in
the package. It ships as a new package, `@flowlet/shell`, depending on
`@flowlet/core` and `@flowlet/react`, kept separate from F2 and F3a to avoid
collisions in `flowlet-react`.

## First principles

1. **Generated UI is the goal; conversation is the means.** The artifact the
   agent produces (a dashboard, a tool, a flow) is the thing of value and the
   hero of the surface. Text, voice, and the transcript are how the user summons
   and shapes that artifact, not what they stare at. Layouts foreground the
   generated UI and demote the transcript to on-demand.
2. **Native, not bolted-on.** The shell adopts the host's look through a token
   contract so it feels like part of the app, while keeping a distinct, classy,
   restrained identity.
3. **Integrations are first-class.** Connecting tools is part of the chat surface
   itself, not buried in settings, because acting for the user is the core value.
4. **Flowlet owns persistence.** Saved flowlets are persisted by Flowlet (not the
   host), which is what unlocks sharing, cron, and automations later.
5. **Reuse F1, do not reinvent it.** The agent, message, registry, and approval
   contracts are consumed as-is. The render surface is a black box behind the F1
   contract.

## Visual identity: INK / LIFT

- Type: Geist for prose, Geist Mono for technical signal only (run id, latency,
  tool-call names, metadata).
- Color: neutral ink accent on white, one accent at a time. No neon, no heavy
  gradients.
- Surface: hairline borders with a soft elevation (lift). Glass is used
  selectively, only on generated-UI cards, never on the chat chrome.
- The only "agent" signal is the quiet mono metadata (for example `live - 312ms`
  and `budget.create ok 188ms`), which keeps it instrument-like and classy.

## Theming

All visual values are CSS custom properties with INK/LIFT as the default token
set: accent, foreground, background, surface, border, radius, shadow, font,
font-mono. The host overrides any `--flowlet-*` token on an ancestor element or
through a `theme` prop. Because these are real CSS variables, host changes (a
rebrand, a theme toggle) flow in live with no React re-render.

- **Smart inherit.** `--flowlet-font` defaults to `inherit` so it picks up the
  host font with no config. The accent falls back to a common host brand variable
  when present, otherwise the INK default.
- **Light / dark.** Auto-follows the host or OS through `color-scheme` and the CSS
  `light-dark()` function. The host can pin it to light or dark.
- **Single source of truth.** The shell exposes the resolved token object so F3
  can serialize it across the sandbox bridge. The shell chrome inherits CSS
  natively; the sandboxed generated UI cannot inherit across the iframe boundary,
  so the token object is what F3 transports.

## The three elements

All three are thin placement wrappers over one shared core. Each owns only its
placement (layout, positioning, open and close).

### `<FlowletPage>` - tabbed workspace

A full-page destination. Each tab is one generated-UI flowlet with its own canvas
and its own conversation. "+" summons a new tab in the empty state. A switcher
(command palette, and the new-tab page) opens any saved flowlet into a tab. Tabs
are the working set of currently open flowlets, not the whole library.

- The canvas (the generated dashboard) is the hero.
- The command bar is ambient. When the tab is empty the bar is the centered hero
  input with a greeting, suggestion chips, and an integrations-forward onboarding
  grid. Once the canvas has content the bar floats at the bottom.
- The connected-tools rail sits directly above the bar.
- Agent feedback, the generating state (with a stop control), and approvals anchor
  to the bar. The transcript is on-demand: a "transcript" toggle expands a thread
  panel over a dimmed canvas, collapsible.

### `<FlowletOverlay>` - the command-bar surface

Lightweight, for when Flowlet is embedded over a host app rather than as a full
page. A launcher (a pill, or a host-bound shortcut such as Cmd-K) opens a centered
command palette over a blurred host. A quick ask expands into a compact thread that
can render UI inline (glass card) or promote it into a page tab via "Open in page".
Other actions: save flowlet, pin. Ephemeral; Esc closes.

### `<FlowletSlot>` - designable container

A container the host drops into its own layout, sitting among the host's native
components. Empty until clicked ("Design a flowlet here"). Clicking opens the
design surface (the overlay's thread, with the integrations rail). The user
describes what they want, sees a draft, and saves it to the slot. The slot then
renders the saved flowlet in place, with a hover toolbar to edit (reopen design),
refresh (re-run), and open in page (promote to a tab). Persists through the
FlowletStore seam.

## Component composition

Layered, small focused parts. Public API exposes the elements, the core, and the
primitives so hosts can drop in or compose their own surface.

- **Elements:** `<FlowletPage>`, `<FlowletOverlay>`, `<FlowletSlot>`.
- **Shared core:** `<FlowletThread>` = Landing (when empty) + MessageList +
  Composer. Reused by all three elements so conversation behavior is written once.
- **Primitives:** Turn, StreamingText, ToolCall, ApprovalCard, UINodeView,
  Composer, VoiceButton, Landing, SuggestionChips, FlowGallery, IntegrationsRail.
  Each small and independently testable.
- **Hooks and view-model:** a new `useFlowletThread()` normalizes
  `messages.parts` into ordered render items (text, tool, approval, ui) so
  primitives never re-parse parts themselves. It sits on F1's `useFlowletChat()`.
- **Renderer seam:** `<UINodeView>` delegates to a `RendererContext`. StubRenderer
  now, F3 sandbox renderer later, behind the same seam.

## Seams

- **FlowletStore** (Flowlet-owned persistence): list, load, save, delete, share
  flowlets. F5 ships the interface plus a default local implementation. The real
  Flowlet-backed client (which enables sharing, cron, automations) lands with
  F6/F7. The shell never assumes host storage. The slot and tabs both persist
  through this.
- **FlowletIntegrations** (tool connections): list, status, connect, disconnect.
  F5 ships the interface plus the UI. The real Composio OAuth flow is wired by F2.
- **RendererContext** (the F3 render surface): a black box behind the F1 contract.
- **Token system:** the resolved theme object, bridged into the F3 sandbox.

## Integrations in the chat surface

Integrations are emphasized on every surface because they live in the shared
composer and thread. There is one entry point, the connected-tools rail, not two.

- **Connected-tools rail** on the composer: a chip per connected integration
  (logo plus a live status dot) and a "+ Connect tools" action that opens the
  picker. Overflow collapses to a few chips plus a count. This is the single
  integrations door; the composer input keeps only mic and send.
- **Integrations-forward empty state:** a new user first sees "Connect your tools
  to begin" with one-click connects, then the composer.
- **Connect-to-continue card:** when the agent needs a tool it lacks, it surfaces
  an inline connect card in the thread (logo, reason, scope, revocable note), like
  an approval card but for auth. Connecting lets the turn proceed.
- **Picker:** a searchable list with connect status, opened from "+ Connect
  tools".

## Data flow

1. The composer calls `useFlowletChat().sendMessage`.
2. The F1 transport drives the agent; the agent emits the UIMessage stream.
3. `useFlowletThread()` normalizes the streamed parts into ordered render items.
4. Primitives render: StreamingText for text, ToolCall for operations,
   ApprovalCard for native approvals, UINodeView for `data-ui` nodes.
5. Approvals route through `addToolApprovalResponse`, which triggers F1's
   automatic resubmit, runs the approved tool, and emits the resulting UI node.
6. UI nodes render through UINodeView and the RendererContext (StubRenderer now).
7. Generated UI surfaces as the canvas (page) or inline (overlay); saving routes
   through FlowletStore.

## Voice

Stubbed affordance only this milestone. VoiceButton with idle, recording, and
disabled states, plus a `useVoiceInput` seam that reports unsupported by default.
No capture pipeline. The seam exists so a real implementation can drop in later.

## Errors, cancellation, consent

- **Errors:** F1's typed error stream parts render as an inline notice in the
  thread. Send failures surface on the composer.
- **Cancellation:** the generating state shows a stop control wired to
  `useFlowletChat().stop`, which propagates the F1 abort signal.
- **Consent:** mutating tools surface as ApprovalCards (F1 native approvals);
  connecting integrations surfaces as connect cards. These are the only paths to
  side effects.

## Accessibility

Important for the native feel. The message list is an ARIA log or feed, the
composer is a form. Keyboard support: Cmd-K to open the overlay, Enter to send,
Shift-Enter for newline, Esc to close. The overlay traps focus while open and
restores focus on close.

## Testing

Vitest plus Testing Library, matching F1. Pointed at risk, not volume:

- The parts-to-items normalizer (`useFlowletThread`).
- The human-in-the-loop loop through `<ApprovalCard>` (mirrors F1's stub test:
  send, approval requested, approve, render the node).
- Composer submit calls `sendMessage`.
- A suggestion-chip click calls `sendMessage`.
- The slot flow: empty, click, design, save, render.
- Theme token application from host overrides.
- Overlay open and close with focus management and Esc.
- Integrations: rail renders connected status; connect-to-continue card calls the
  integrations seam.

## Scope and non-goals

In scope: the three elements, the shared core and primitives, the theme system,
the FlowletStore and FlowletIntegrations seams with default local
implementations, the stubbed voice affordance, and rendering against the F1 stub
renderer.

Out of scope (later milestones): the real sandbox renderer (F3), the real LLM
engine and Composio OAuth (F2), real Flowlet-backed persistence, sharing, cron and
automations (F6/F7), real memory (F6), and a real voice capture pipeline.

## Explicit assumptions

- `FlowletProvider` is the required ancestor. The shell adds only a lightweight
  theme layer and a RendererContext on top.
- No new chat state store. All conversation state stays in F1's `useChat`.
- A saved flowlet is a UI node plus its context, owned by Flowlet through the
  FlowletStore seam.

## Open questions

- The concrete FlowletStore shape for sharing and automations (refined when F6/F7
  land).
- The integrations metadata shape from Composio (refined when F2 wires it).
- Tab overflow behavior at large counts (scroll, menu, or both).
