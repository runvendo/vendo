# $87 Mystery — Demo Runbook

Everything to run the Vendo × Maple demo on stage, reset it, and recover if a
beat misbehaves.

## Start

```bash
pnpm demo
```

(= `infisical run --projectId=b366cac7-1716-47a0-9617-f335500f6dee --env=dev -- pnpm --filter demo-bank dev`)

Open http://localhost:3000. The Vendo dock sits bottom-right; Gmail + Slack
show "Connected".

Secrets come from Infisical (`dev`): `ANTHROPIC_API_KEY`, `COMPOSIO_API_KEY`.
No keys are committed. Model: `claude-sonnet-4-6` (override with `VENDO_DEMO_MODEL`).

Dock controls (top-right): **↺** reset and **×** close. Closing the dock leaves an
"Ask Maple" relauncher pill bottom-right. Cmd/Ctrl+K opens the same thread as an
overlay from anywhere.

The agent's real Composio identity is attached only for **local** requests. To run
the demo on a reachable deployment, set `VENDO_DEMO_PUBLIC=1` (otherwise the chat
route returns 403 so a stray preview URL can't drive the agent).

## Before you walk on stage — reset

Click the **↺** in the dock's top-right, or press **Cmd/Ctrl+Shift+.** (period).
This re-seeds Maple (planted $87 back, any test orders gone), clears the rule,
re-baselines the detector, and reloads to a clean thread. Identical start state
every run.

## Pre-flight (once, before the session)

1. `pnpm composio:connect` — confirms Gmail + Slack are ACTIVE for `vendo-demo`.
   If a toolkit isn't connected, it prints an authorize URL — open it and sign in
   with the inbox that holds the DoorDash receipt / the Slack workspace with
   `#general`.
2. Make sure the "snitch" friend and a phone are in that Slack workspace's
   `#general`.

## Surfaces (all live)

- **Docked composer** (bottom-right) — the primary on-stage surface; the 3 beats run here.
- **Cmd/Ctrl+K overlay** — the same agent + **same thread** from anywhere; a card made in the dock shows here too.
- **Vendo tab** (sidebar) — a full-page version (its own thread); the floating dock hides on that route.

## The three beats

**Beat 1 — the clock.** Type:
> What did I spend money on when I should've been asleep?

→ Vendo calls `get_transactions` and renders a 24-hour radial clock with the
**$87 @ 1:14 AM DoorDash** dot lit in the "asleep" band.

**Beat 2 — Gmail.** Type:
> What was that $87 DoorDash charge?

→ Vendo reads the **real** Gmail receipt via Composio and renders an itemized
card: 6 Crunchwrap Supremes, 4 Nachos BellGrande, 2 Baja Blasts, Total **$87.00**,
ordered **1:14 AM**.

**Beat 3 — the snitch.** Type:
> Put me on blast in the company Slack every time I order late-night delivery.

→ Vendo sets a natural-language rule and shows a green **"Rule set"** Callout.
Then place the live order (below). The detector fires and a **real Slack message
posts to #general** — the friend's phone buzzes. Close on *"All I needed was
your email."*

## The close

Every view Vendo generated persists as a tappable card in the **"Your views · saved"**
strip (bottom-left). Click one to reopen the full view in a modal — "the views you
build don't vanish; you keep them."

## Placing the live order (Beat 3 trigger)

Primary: navigate to **`/order`** (use a same-tab/client navigation so the dock
thread is preserved) and click **Place order**. The detector polls Maple's
existing transactions API (~2s), matches the late-night rule, and fires.

Fallback (no navigation): press **Cmd/Ctrl+Shift+\\** anywhere — it injects the
same late-night order. The detector trips identically.

## If something misbehaves

- **Slack didn't post:** the dock banner still shows "Rule fired → posted"
  (canned fallback) so the beat completes on screen; the real post is via
  Composio — re-run `pnpm composio:connect` to confirm the Slack connection.
- **A view shows "Invalid component props":** rare; just re-ask — the agent
  regenerates. (Component prop names are included in the agent's catalog to make
  this unlikely.)
- **Order page flip lost the thread:** you did a hard URL load. Navigate
  client-side, or use the Cmd/Ctrl+Shift+\\ inject instead.
- **Total reset:** ↺ / Cmd/Ctrl+Shift+. , or restart `pnpm demo`.

## What's real vs. staged

- Real: the agent (Claude), the generated UI, the Gmail receipt read, the Slack
  post, the late-night detection over Maple's own API.
- Staged: the planted $87 charge in Maple's seed; the late-night order you place
  is timestamped 1:3x AM so it reads as late-night on stage.
