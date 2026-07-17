# Generation presentation + director mode

Goal: the hero demo starts from the ORIGINAL dashboard card, customizes it in
place through the Vendo overlay into a working micro-app, raises the real
approval after creation, and lands the approval as a top-bar notification —
all in the real components, drivable deterministically for the 36-second take.

## The real flow (grounded in code, not mocked)

1. **Start from the original.** Cadence's `MissingDocsHero` renders bare in
   `stat-row.tsx`; it must be wrapped in the slot machinery
   (`VendoSlot`/`PinMount`, slot = `CadenceMissingDocsHero`) with the original
   component as fallback, plus host wiring that resolves which app is pinned
   to that slot. That is what lets the card on the dashboard *become* the
   remixed app in place.
2. **Customize through the overlay.** The user opens the floating Vendo
   overlay (`VendoOverlay`, already mounted by `VendoLayer`) on the dashboard
   and types the remix ask. The fork-pin + app creation stream back as
   `data-vendo-view` parts; the slot content transitions original → forming →
   micro-app.
3. **A real micro-app, not gen UI.** The generated app carries actions
   ("Nudge all", per-client nudge) wired through `AppFrame.onAction →
   client.apps.call → host sendClientMessage` — interactive, host-API-backed.
4. **Approval comes after creation, from the run.** When the app's Slack post
   first fires, the guard raises `approval-requested`; the `ApprovalCard`
   materializes beneath the generated view (Cadence's
   `.cadence-approval-inflow` already styles this placement). No up-front
   "connect" framing.
5. **Approve → top-bar morph.** The approval card FLIPs into the prepared
   `fl-auto-created` notification bar (solid surface — the derived tokens live
   under `.vendo-root`; any mount must sit inside that scope).

## Work items

### B — presentation (packages/ui, ships for real)
- Build-line component replacing raw tool chips in the thread: human,
  per-tool progress labels; full detail stays in the Activity panel. Update
  DOM-contract tests that assert chip text.
- Wire the existing-but-unmounted FluidReveal morph (`.fl-reveal`) for
  skeleton → component transitions; staggered sibling reveals.
- Slot transition: original card → glass forming state → mounted app, using
  the same reveal machinery on `VendoSlot` content changes.
- Mount the `fl-auto-created` proposal→toast morph for approval decisions
  (component exists in CSS only today).

### B2 — Cadence host wiring
- Wrap the dashboard hero in slot + pin-resolution so a remixed app replaces
  it in place; keep the original as fallback (pin drop-back stays honest).
- Micro-app action handlers (nudge → sendClientMessage) verified end to end.

### C — director mode
- Record: tee the SSE part stream of a real build to JSON.
- Replay: scripted transport (swap for `DefaultChatTransport` in
  `useVendoThread`) emitting recorded parts at authored pacing; env-gated +
  query-param opt-in; never on by default.
- Author the 36-second sequence from a real recording of the hero build.

## Choreography (M1, approved)

Prompt → build line narrates in plain words → glass silhouettes shimmer →
components morph in staggered (hero count-up, rows, chart) → schedule badge →
nav/tab moment → approval card in-flow beneath the view → approve → top-bar
notification morph → settle.
