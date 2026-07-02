# Gmail clone (demo prop) + Flowlet ("Vendo")

Vendored from [Tobi-davies/Gmail-Clone](https://github.com/Tobi-davies/Gmail-Clone) (CRA + Redux + styled-components; **no license declared upstream** — internal demo use only, do not ship or publish), now integrated with Flowlet in embedded mode: the runtime runs in the app's own Express backend, and the shell's three surfaces are installed as "Vendo".

## Run

```sh
pnpm demo:gmail   # from the repo root — server (:3198, via Infisical secrets) + web (:3199)
```

The app is part of the pnpm workspace (React 18, craco). `predev` builds the React shim and the merged sandbox bundle (catalog + this app's registered host components) into `public/flowlet/`.

## What's where

- `server/` — the mail backend (seeded in-memory store + REST API) and the embedded Flowlet runtime: agent (`server/flowlet/agent.ts`), policy, streamed chat route, and the governed action route with one-time approval tokens for gated writes.
- `src/openapi.json` — the host API contract (ENG-202): one derivation feeds the server's caller seam and the browser's client executor.
- `src/flowlet/` — provider root, sandbox stage (in-flow ApprovalCard consent), the three surfaces (page `/flowlet`, Cmd/Ctrl+K overlay, inbox slot), host-component descriptors, brand tokens.
- `flowlet-sandbox/` — sandbox bundle entry + adapters binding the app's real components (`GmailEmailRow`, `GmailComposeChip`) via `installFlowletHost`.
- `.flowlet/` — `flowlet init` output, hand-fixed (see `docs/superpowers/specs/2026-07-02-gmail-extraction-fidelity-findings.md`).

## What's real vs fake

- **Real:** server-backed inbox/starred/sent (survives reload; `POST /api/flowlet/reset` reseeds), read view (mark-read/delete/star), compose → send, the agent acting through the app's API as the user with approval-gated writes, model-drafted replies, and REAL Slack posts via Composio (`flowlet-demo`, #general).
- **Fake/static:** search bar (search exists as an agent tool instead), pagination arrows, category tabs, Drafts/Spam counts, remaining left-nav items.

## The demo beat

Type into Vendo, verbatim: *"Turn my unread emails into Tinder: swipe left to delete, swipe right to reply for me. Swipe up to send it to my team's Slack with a quick summary."* The agent generates a working swipe deck over the real unread mail; left = delete, right = model-drafted reply-send, up = real Slack summary — each gated by an approval card under the view.
