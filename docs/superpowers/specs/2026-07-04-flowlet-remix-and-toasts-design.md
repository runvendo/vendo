# FlowletRemix + FlowletToasts: two new shell surfaces

Date: 2026-07-04
Status: Approved design (Codex-reviewed, 10 findings triaged and folded in), pre-plan
Owner: Yousef (approval delegated for this epic: spec, plan, build, PR open; merge stays with Yousef)

## Why

Three drivers, confirmed in brainstorm:

1. Host-app fit gaps. Real integrations (Cadence, Gmail clone, demo-bank) need the agent to act on specific things on screen, and automations run in the background with nowhere native to surface results.
2. OSS launch appeal. A richer surface menu strengthens the install story.
3. Agentic UX ambition. Push past chat-in-a-box toward in-place and ambient agent behavior.

This spec adds two surfaces to `@flowlet/shell` (today: `FlowletPage`, `FlowletOverlay`, `FlowletSlot`) plus one cross-cutting seam. It stays inside the locked platform architecture: toast delivery rides the existing `Channels` seam, remix persistence is an additive `Store` seam extension, and no new seams are introduced.

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

### Baseline snapshot (what the agent remixes from)

The baseline is the actual component. When the scoped overlay opens, the anchor captures a snapshot of the wrapped component's rendered DOM and sends it with the context payload, so a remix reads as the host's own component with a delta, not a from-scratch view. Snapshot contract (fixed, not configurable in v1):

- Included: tag names, `class`, `aria-*`, `role`, visible text content, table/list structure.
- Excluded: `<input>`/`<textarea>`/`<select>` values, hidden elements (`display:none`, `visibility:hidden`, `aria-hidden`), `data-*` attributes, inline event handlers, `<script>`/`<style>`, iframes.
- Caps: max depth 12, max 32 KB serialized; overflow truncates depth-first with a truncation marker the agent can see.
- The snapshot is sent only when the user opens that anchor's scoped overlay, never ambiently.

### Remix flow

- Customizations come back in the thread as a generated view (same sandboxed `render_view` pipeline, host catalog components available for brand fidelity) with an Apply button. The thread is the preview; there is no separate preview UI.
- Thread protocol (additive): outgoing messages sent from a scoped overlay carry an anchor block (`anchorId`, label, context, snapshot) as message metadata; a generated view produced in a scoped conversation is tagged as a remix candidate for that `anchorId`; Apply is a shell action that writes the pin, Reset deletes it. Untagged views and unscoped conversations behave exactly as today.
- Apply swaps the generated view in place of the wrapped children, with a small "customized / reset" pill.
- Accepted v1 limitation (explicit): a remixed view does not inherit the original component's event handlers, local state, or navigation. Its interactivity is whatever the generated view can do: cataloged host components and registered tools. The spec makes this a documented property, not a bug.

### Persistence: RemixStore (additive Store seam extension)

Saved flowlets are the wrong record: `SavedFlowlet.query` is re-executed via the Executor on reopen, but a remix's data source is the anchor itself. Instead, an additive sub-store on the `Store` seam:

- `RemixStore`: `pin(scope, anchorId, record)`, `get(scope, anchorId)`, `unpin(scope, anchorId)`, upsert semantics, one pin per `(principal, anchorId)`.
- Record: `uiTree` (same `UINode` contract), `originatingPrompt`, `components` version map (same field and drift semantics as ENG-186 saved-flowlet versioning), timestamps store-assigned.
- Reset unpins; the host component returns instantly.
- Live data: the anchor's `context` flows into the pinned view as host props on every render (same host-prop validation path as ENG-186), so the remix stays current without re-generation and without bypassing the tool path: the anchor is the declared data source.

### Page-context registry (cross-cutting seam)

A `PageContextRegistry` living in the shell provider (per `FlowletProvider` instance, not global):

- Anchors register on mount, deregister on unmount (route changes fall out of mount lifecycle). Registered and mounted means visible in v1; no intersection observation.
- Duplicate `id`: last mount wins, dev-console warning.
- Caps: 32 anchors, 4 KB context per anchor and 16 KB total sent as ambient context; overflow drops largest payloads first with a warning.
- Consumers: plain Cmd+K opens the overlay with the visible anchors (id, label, context, no DOM snapshots) as ambient context, so "chase the overdue ones" works without clicking any specific element. One seam powers anchor-scoped asks, Cmd+K context, and remix targeting.

## Surface 2: FlowletToasts

The delivery half of automations: a small transient card that slides into a corner of the host app when the agent did something in the background.

### Architecture: the in-app Channels surface

The locked architecture reaches users off-thread through the `Channels` seam (`deliver(OutboundMessage)`, kind `in-app`), whose contract anticipates in-app surfaces upgrading rendering. FlowletToasts is that upgrade: no new event bus, no new seam.

- `OutboundMessage` gains an optional structured payload (additive): `automation?: { kind: "completed" | "approval-required"; runId: string; stepId?: string; summary: string }`.
- The embedded `Channels` impl routes `in-app` deliveries to the client; a thin client adapter turns them into toast state. Cloud deployments reuse the same contract later.

### Mounting

`@flowlet/shell` exports `FlowletToasts`; the `FlowletRoot` in `@flowlet/next` mounts it by default (opt-out prop, placement knob), so `flowlet init` apps get it with zero config. Hosts not using `@flowlet/next` mount it manually.

### Events (exactly two)

1. `completed`: any run finished, scheduled or trigger-fired, with outcome summary and click-through to the run. Trigger-driven reactions are just completions of trigger-started runs; they are not a separate event type (decided: a third event type was cut as redundant).
2. `approval-required`: a run is paused waiting on the user. Inline Approve / View. Approve bridges to the automation runner's resume (`resumeTarget { stepId, approved }`), not to chat tool-approval parts; idempotent per `(runId, stepId)`. If the run is no longer waiting (expired, cancelled, already resumed elsewhere), the toast flips to a stale state that links to the run. Adopts the ENG-193 consent channel when it lands.

### Policy (hard-coded v1)

- Max 2 visible; the rest queue.
- Suppressed while the user is actively mid-conversation on any surface.
- Auto-dismiss ~8s, except approvals, which persist until acted on.
- A missed toast loses nothing: runs and pending approvals remain visible in the existing automations panel, which is the durable source of truth. Toasts are ephemeral projections of `AutomationRun` state.
- While-you-were-away: on app open, runs finished since the per-principal last-seen cursor collapse into one summary toast. The cursor is client-persisted (localStorage) in v1; single-device is an accepted embedded limitation.
- No proactive suggestions, no marketing, no cross-session push. Toasts exist only while the app is open.

## Failure handling

Fail-open, always. The host's own component is the permanent fallback:

- If a pinned remix errors in the sandbox, fails validation, or hits the components drift notice, the anchor renders its original children with a "customization unavailable, reset or retry" state on the pill. A broken remix must never break the host page.
- Toast action failures (e.g. approve fails) turn the toast into an error state that links through to the run, where the real error lives. Bridge errors must reject, never swallow.
- SSR: `FlowletRemix` renders children only on the server; the affordance, snapshot, and registry are client-side.

## Testing

- Unit and component tests in `@flowlet/shell` existing vitest patterns: registry mount/unmount/duplicate/caps, snapshot inclusion/exclusion/cap rules, pin/unpin/reset lifecycle, live host-prop re-render of a pinned view, toast queue policy (max 2, suppression, approval persistence, stale approval, while-you-were-away collapse).
- Contract tests: `RemixStore` semantics, extended `OutboundMessage` schema, thread anchor-block metadata.
- Real-browser verification in Cadence per repo rule: wrap the outstanding-invoices widget in `FlowletRemix`, run the remix beat end to end, fire a run for the completion toast and an approval toast. Screenshots in the PR.

## UI gate

Both surfaces are visual. Yousef has pre-approved this epic end to end (2026-07-04) and will review the shipped UI in the PR; the PR is not merged without him.

## Decided against / deferred

- Highlight-to-ask chip and standalone anchor popover: deferred; the scoped overlay covers the need.
- Dev-declared quick-action chips on anchors: cut from v1.
- Config-patch remix (dev-declared remixable schema, host re-renders itself): rejected for v1 in favor of generated views, which work on any wrapped component with zero extra dev work.
- Agent Tray (inbox) and in-place badges: deferred ambient surfaces; "while you were away" toast covers the gap for now.
- Proactive suggestion toasts: out of scope.
- Snapshot configurability (host redaction overrides): deferred until a real host needs it.

## Dependencies and open alignment points

- Channels seam (shipped in contracts freeze): additive `OutboundMessage.automation` payload; embedded impl must route in-app deliveries to the client adapter.
- Store seam: additive `RemixStore` sub-store (contracts addition, same authorship rules as existing sub-stores).
- Automations engine (ENG-188 phase 2, underway): runner must emit the two deliveries via Channels and accept idempotent resume.
- ENG-193 permissions design: the approval toast is a consent-channel surface; v1 bridges to runner resume directly and migrates when ENG-193 ships.
