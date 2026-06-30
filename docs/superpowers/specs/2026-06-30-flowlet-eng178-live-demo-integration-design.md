# Flowlet × Maple — "$87 Mystery" Live Demo Integration (ENG-178)

**Status:** Design approved, pending spec review
**Issue:** ENG-178 (D2 · Integrate Flowlet + live trigger + polish + deploy)
**Acceptance:** ENG-172 — the "$87 Mystery" runs end-to-end on stage, closing on *"All I needed was your email."*
**Source of truth for staging:** YC Product Showcase Demo Script (Notion).

## Goal

Make the "$87 Mystery" demo work end-to-end inside the Maple demo bank: a user types
questions a bank has no screen for, Flowlet generates bespoke views, reads a real Gmail
receipt, sets a natural-language rule, and fires a real Slack message when a late-night
order lands. Reliability on stage is the top priority; purity of "generated from nothing"
is second to "it works every run."

## What already exists (reuse, do not rebuild)

The full Flowlet stack is on `main`: the server-only agent engine (`createFlowletAgent`
— anthropic model + Composio gmail/slack + natural-language approval policy), 15 prewired
components, the sandboxed stage renderer, and the shell (thread + three embed elements:
Page / Overlay / Slot). The `render_ui` → `data-ui` → stage pipeline is built.

## What this issue builds (the gaps)

1. **Flowlet wiring in `apps/demo-bank`** — none exists today.
2. **Networked path** — the agent is server-only (Composio uses Node internals). Needs a
   Next.js API route that streams `agent.run()`, plus an HTTP transport on the client.
   The only transport today runs the agent in-process.
3. **Principal threading** — `userId` must cross the transport, or Composio fails closed
   and Gmail/Slack are silently dropped.
4. **Real renderer in the shell** — wire `FlowletStage` into the shell's `renderNode`.
5. **Beat 3 machinery** — Maple's first write (Order page), a rules store, a polling
   detector, and the Slack fire, all with fallbacks.

## Architecture

Maple gains a **Flowlet layer** that sits beside its existing bank routes and never
modifies them. The layer is conceptually separate even though it lives in the same Next
app.

```
Browser (Maple)
  home docked composer  ─┐
  Cmd+K overlay         ─┼─ one shared Flowlet thread (shell)
  Flowlet tab (proof)   ─┘        │
                                  │  HTTP transport (ai SDK)
                                  ▼
  POST /api/flowlet/chat  ── streams agent.run() ──► createFlowletAgent
                                                       (anthropic + Composio + policy)
                                                          │
                          Composio (userId=flowlet-demo) ─┤ Gmail receipt read
                                                          └ Slack send (#general)

  GET /api/transactions (Maple's EXISTING read API)
        ▲
        │ ~2s poll (diff for new rows)
  /api/flowlet/poller ── matches active rules ──► Composio Slack send
        ▲
        │ writes a new transaction
  POST /api/orders (Maple's first WRITE) ◄── Order page "Place order"
```

**Key principle:** detection is by **polling Maple's existing transactions API**, not a
backend hook. This is how a real drop-in layer integrates with a bank it cannot modify,
and it keeps the demo true to the thesis ("we didn't touch the bank"). It also gives one
detection path for both the real order and the backstage fallback inject.

## Embed surfaces

All three shell elements are wired into Maple to prove "drop in anywhere":

- **Home docked composer** — primary live path. Input bar at the bottom of Maple's real
  home; generated views render as inline cards and persist.
- **Cmd+K overlay** — secondary live path; same agent reachable from anywhere.
- **Flowlet tab** (`FlowletPage`) — present as a proof point, not the live path.

All surfaces **share one conversation thread and agent session**, so a view generated in
one is visible in the others. `FlowletStage` is wired into the shell `renderNode` so
generated UI renders in the sandbox (replacing the non-production fallback).

## The three beats

### Beat 1 — Generative UI: the radial clock
A new prewired **`TimeOfDayClock`** component in `@flowlet/components` (24-hour radial
clock, late-night hours lit, a fat **$87 dot at 3:39 AM**). The agent selects it via
`render_ui` and supplies the data. **Hybrid approach:** prewired now for stage
reliability; the F3b generated-UI path is wired so the same beat can run as true generated
UI once ENG-180 merges. Demoed as generated; prewired is the never-fails fallback.

### Beat 2 — Gmail is the hero
The agent calls Composio Gmail, finds the **real 3:39 AM** DoorDash receipt in the inbox,
and renders an itemized card (prewired `Card` / `List`): *six Crunchwraps, four nachos,
two Baja Blasts. Party of one.* The bank only ever saw "DOORDASH — $87"; the detail comes
from outside the bank.

### Beat 3 — The snitch + live action
The agent sets a natural-language rule ("post to #general on any late-night delivery"),
stored in a small **Flowlet-layer rules store** (distinct from the policy/approval layer,
which gates tool calls rather than reacting to events). The shell shows a "Rule set"
confirmation. On stage: open Maple's new **Order page**, place a late-night order (writes
a transaction), switch back; the **poller** sees the new row, matches the rule on the
transaction's late-night timestamp, and fires a **real Composio Slack message to
`#general`**; the friend's phone buzzes. The thread shows "Rule fired → posted."

## The planted data

The seeded charge `txn_doordash_87` is **re-timed from 1:14 AM to 3:39 AM** to match the
real Gmail receipt, so Beat 1 (bank dot) and Beat 2 (receipt) show the same time on stage.
The Notion script's "1:14am" references are updated to "3:39am". Everything else about the
seed (amount −8700, category dining, descriptor `DOORDASH*ORDER 8742 CA`, most-recent
position) is unchanged and deterministic.

## Integrations status in the UI

The shell's Integrations rail is backed by **real Composio connection status** for the
`flowlet-demo` user, so Gmail and Slack show live "Connected" pills (not seed data).

## Configuration & secrets

- **Secrets via Infisical** (project `b366cac7-1716-47a0-9617-f335500f6dee`, env `dev`):
  `ANTHROPIC_API_KEY`, `COMPOSIO_API_KEY`. Injected with
  `infisical run --projectId=… --env=dev -- pnpm dev`. No secrets committed.
- **Principal:** fixed `userId = flowlet-demo` scopes the Composio connected accounts.
- **Composio OAuth connect:** a one-time setup script prints the Gmail + Slack authorize
  URLs for `flowlet-demo`; Yousef clicks them once to grant access. The agent assumes the
  account is already connected and just fetches that user's tools.
- **Slack target:** `#general`.

## Fallbacks (reliability on stage)

- **Order placement:** real Order page is primary; a discreet backstage **inject**
  (button / keyboard shortcut) is the fallback if the Order page misbehaves. Both trip the
  same poller.
- **Slack send:** real Composio send is pre-tested; if it fails live, a **canned/simulated
  post** completes the beat visually (friend's phone buzz pre-arranged).
- **Beat 1 render:** prewired `TimeOfDayClock` is the fallback if the F3b generated path
  is used and stumbles.

## Error handling

- Missing/empty `userId` → Composio fails closed (already the engine's behavior); surfaced
  as a clear "not connected" state in the Integrations rail rather than a silent drop.
- Agent route streams errors as thread error items (the shell already renders `error`
  ThreadItems).
- Poller is idempotent: it tracks already-fired transaction IDs so a rule fires once per
  order even across poll cycles.

## Testing

- **Unit:** rules store (match/no-match on timestamp), poller diff/idempotency, the
  `TimeOfDayClock` component props, the Order write.
- **Integration (offline, mock models):** chat route streams a `render_ui` result; the
  existing mock-model pattern (`examples/basic/src/realAgent.ts`) is the template.
- **Live (gated on keys):** Composio Gmail read + Slack send smoke (mirrors the existing
  `composio.live.test.ts`), run via `infisical run`.
- **Visual:** render each beat and screenshot to verify on-screen output, not just unit
  assertions.

## Out of scope (this issue)

- The F3b declarative renderer itself (ENG-180) — we wire the path and pull it in when it
  merges.
- Productionizing Composio OAuth UX beyond the one-time demo connect.
- Maple writes beyond the single Order action needed for Beat 3.

## Sequencing

End-to-end flow first (route + transport + embed + the three beats with prewired/fallback
paths), then polish/animation of the wow moments, then deploy to a stage-ready URL. Pull
F3b in when it lands on `main`.
