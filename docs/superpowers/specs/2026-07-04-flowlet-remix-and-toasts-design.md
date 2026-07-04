# FlowletRemix + FlowletToasts: two new shell surfaces

Date: 2026-07-04
Status: Approved design, pre-plan
Owner: Yousef

## Why

Three drivers, confirmed in brainstorm:

1. Host-app fit gaps. Real integrations (Cadence, Gmail clone, demo-bank) need the agent to act on specific things on screen, and automations run in the background with nowhere native to surface results.
2. OSS launch appeal. A richer surface menu strengthens the install story.
3. Agentic UX ambition. Push past chat-in-a-box toward in-place and ambient agent behavior.

This spec adds two surfaces to `@flowlet/shell` (today: `FlowletPage`, `FlowletOverlay`, `FlowletSlot`) plus one cross-cutting seam.

## Surface 1: FlowletRemix

The product thesis applied to existing UI: a dev wraps one of their own components, it renders exactly as today by default, and end users can ask the agent to customize it. The customization persists for that user.

### Dev API

`<FlowletRemix id label context>{children}</FlowletRemix>`

- `id` (required): stable string, identity for persistence and context.
- `label`: human name used by the agent and in the overlay header.
- `context`: serializable payload describing the wrapped thing (entity type, data). Feeds the agent and the pinned view.

Everything wrapped is remixable; there is no opt-in flag. No dev-declared quick actions in v1 (decided: cut, the scoped overlay plus free-form ask covers "act on this").

### Interaction

- A themable star affordance appears on hover/focus of the wrapped element (position and style knobs, brand-token aware).
- Clicking it opens the existing `FlowletOverlay`, pre-scoped: anchor label in the header, anchor context attached to whatever the user asks. No new chat UI.
- The user can ask anything: a question, an action, or a customization.

### Remix flow

- Customizations come back in the thread as a generated view (same sandboxed `render_view` pipeline, host catalog components available for brand fidelity) with an Apply button. The thread is the preview; there is no separate preview UI.
- Apply swaps the generated view in place of the wrapped children, with a small "customized / reset" pill.
- Persistence: the remix is a saved flowlet pinned to `(anchor id, user)` on the existing saved-flowlets registry, riding registry versioning and the drift notice.
- Reset unpins; the host component returns instantly.
- Live data: the anchor's `context` data flows into the pinned view on every render, so the remix stays current without re-generation.

### Context seam (cross-cutting)

Mounted `FlowletRemix` wrappers register in a shell-level page-context registry. Every surface gains page awareness from it: plain Cmd+K opens the overlay with the visible anchors as ambient context, so "chase the overdue ones" works without clicking any specific element. One seam powers anchor-scoped asks, Cmd+K context, and remix targeting.

## Surface 2: FlowletToasts

The delivery half of automations: a small transient card that slides into a corner of the host app when the agent did something in the background.

### Mounting

Provided automatically by `FlowletRoot` (opt-out prop, placement knob). Zero-config in the `flowlet init` story.

### Events (exactly two, from the runtime's client-side event bus)

1. `automation:completed`: any run finished, scheduled or trigger-fired, with outcome summary and click-through to the run's thread. Trigger-driven reactions are just completions of trigger-started runs; they are not a separate event type (decided: a third `automation:event` type was cut as redundant).
2. `automation:approval-required`: a run is paused waiting on the user. Inline Approve / View in chat. Wired to existing pending-approval mechanics now; adopts the ENG-193 consent channel when it lands.

### Policy (hard-coded v1)

- Max 2 visible; the rest queue.
- Suppressed while the user is actively mid-conversation on any surface.
- Auto-dismiss ~8s, except approvals, which persist until acted on.
- Every toast event also lands in thread history; a missed toast loses nothing.
- On app open, unseen background results collapse into one "while you were away" toast.
- No proactive suggestions, no marketing, no cross-session push. Toasts exist only while the app is open.

## Failure handling

Fail-open, always. The host's own component is the permanent fallback:

- If a pinned remix errors in the sandbox, fails validation, or hits the registry drift notice, the anchor renders its original children with a "customization unavailable, reset or retry" state on the pill. A broken remix must never break the host page.
- Toast action failures (e.g. approve fails) turn the toast into an error state that links through to the run's thread, where the real error lives. Bridge errors must reject, never swallow.
- SSR: `FlowletRemix` renders children only on the server; the affordance is client-side.

## Testing

- Unit and component tests in `@flowlet/shell` existing vitest patterns: registry mount/unmount, pin/unpin/reset lifecycle, live-data re-render of a pinned view, toast queue policy (max 2, suppression, approval persistence, while-you-were-away collapse).
- Contract tests for the two runtime events.
- Real-browser verification in Cadence per repo rule: wrap the outstanding-invoices widget in `FlowletRemix`, run the remix beat end to end, fire a morning-chase run for the completion toast and an approval toast. Screenshots in the PR.

## UI gate

Both surfaces are visual. Yousef reviews the actual UI before build and again before merge, per the standing rule.

## Decided against / deferred

- Highlight-to-ask chip and standalone anchor popover: deferred; the scoped overlay covers the need.
- Dev-declared quick-action chips on anchors: cut from v1.
- Config-patch remix (dev-declared remixable schema, host re-renders itself): rejected for v1 in favor of generated views, which work on any wrapped component with zero extra dev work.
- Agent Tray (inbox) and in-place badges: deferred ambient surfaces; "while you were away" toast covers the gap for now.
- Proactive suggestion toasts: out of scope.

## Dependencies and open alignment points

- Saved-flowlets registry (shipped, ENG-183/186) for remix persistence and drift notices.
- Automations engine event bus (ENG-188 phase 2, underway) must expose the two client-side events.
- ENG-193 permissions design: the approval toast is a consent-channel surface; v1 uses existing pending-approval mechanics and migrates when ENG-193 ships.
