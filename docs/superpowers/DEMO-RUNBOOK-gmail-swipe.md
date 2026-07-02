# Demo runbook — Gmail × Flowlet "Tinder for your inbox"

The one beat: type a prompt, watch Vendo generate a swipe deck over the real unread inbox, and swipe to delete / reply / post-to-Slack — each behind an approval card that shows exactly what will happen.

## Start it

```sh
pnpm demo:gmail   # from the repo root
```

This runs, under Infisical (secrets injected):
- the backend on **127.0.0.1:3198** (mail API + Flowlet runtime), and
- the web app on **http://localhost:3199**.

Open **http://localhost:3199**. The AI page is **"Vendo"** in the left nav (`/flowlet`); the overlay is **Cmd/Ctrl+K** anywhere; there's also a generative slot at the top of the inbox.

### Networking gotcha (read this if a swipe 403s)

The backend binds to **loopback only** and the chat/action routes reject non-local hosts. This is the security boundary — the agent posts to a real Slack workspace, so it must not be drivable from off-box.

- Running on your own machine at `localhost` → works out of the box.
- Demoing over a **tunnel or LAN** (ngrok, a shared URL, a different host in the Host header) → every swipe returns 403. Set **`FLOWLET_DEMO_PUBLIC=1`** in the environment before `pnpm demo:gmail` to opt in. Only do this for a trusted demo — it removes the host guard (the loopback bind still applies, so you still need the tunnel to terminate on this box).

## Prerequisites

- **Anthropic** — `ANTHROPIC_API_KEY` (in the Infisical `dev` env). Drives the agent, the reply drafting, and the Slack-summary writing.
- **Slack** — the `flowlet-demo` Composio account must have an **active** Slack connection (same one demo-bank uses). The summary posts to **#general** (`C09U93V4ER3`). If the connection has dropped, the up-swipe fails **loudly** on the approval card ("Slack post failed: …") — it never fakes success. Reconnect with `pnpm composio:connect` and re-authorize Slack.

## The beat — type this verbatim into Vendo

> Turn my unread emails into Tinder: swipe left to delete, swipe right to reply for me. Swipe up to send it to my team's Slack with a quick summary.

Vendo reads the unread inbox and generates a Gmail-styled swipe deck (7 cards to start). On each card:

| Gesture | Fallback button | What happens |
| --- | --- | --- |
| Swipe **left** | Delete | Moves the email to trash |
| Swipe **right** | Reply | Drafts a reply in your voice and sends it |
| Swipe **up** | Slack | Posts a one-line summary to #general — a **real** Slack message |

Every card also has **Delete / Reply / Slack buttons** — use them if a drag doesn't register (pointer capture can drop when a drag leaves the card's iframe). The buttons run the exact same governed actions.

### The approval gate

Delete, reply, and Slack all pause on an **approval card** rendered under the deck. The card shows what you're approving before anything happens:
- **Reply** — the sender, the subject, and the **full drafted reply text**.
- **Slack** — the **exact line** that will post.
- **Delete** — the sender + subject of the email being trashed.

Approve to proceed; decline to cancel. The card's content is what actually runs (bound server-side), so what you read is what goes out.

### Confirming the effects in the app

- Reply → open **Sent**; the drafted reply is there.
- Delete → the email is gone from the inbox (badge count drops); it's in Trash.
- Slack → check the real **#general** channel (or `SLACK_FETCH_CONVERSATION_HISTORY`).

## Reset between takes

```sh
curl -X POST http://localhost:3199/api/flowlet/reset
```

Reseeds the mailbox (7 unread, empty-ish Sent) and clears the reply/Slack dedup guards so you can run the beat again cleanly. Reload the page afterwards.

## Safety notes (so nothing surprises you on stage)

- Each real action needs an explicit **Approve** — nothing sends on the swipe alone.
- **Idempotency:** a second reply or Slack post to the same email is refused ("already sent / already posted"), so a double-swipe or gesture-plus-button can't double-fire.
- **Slack markup** from email content (`<!channel>`, links) is escaped before posting — a crafted subject can't @-channel your workspace.
