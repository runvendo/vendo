# Gmail clone (demo prop) + Vendo ("Vendo")

Vendored from [Tobi-davies/Gmail-Clone](https://github.com/Tobi-davies/Gmail-Clone) (CRA + Redux + styled-components; **no license declared upstream** — internal demo use only, do not ship or publish), now integrated with Vendo in embedded mode: the runtime runs in the app's own Express backend, and the shell's three surfaces are installed as "Vendo".

## Run

```sh
pnpm demo:gmail   # from the repo root — server (:3198, via Infisical secrets) + web (:3199)
```

The app is part of the pnpm workspace (React 18, craco). `predev` builds the React shim and the merged sandbox bundle (catalog + this app's registered host components) into `public/vendo/`.

## What's where

- `server/` — the mail backend (seeded in-memory store + REST API) and the embedded Vendo runtime: agent (`server/vendo/agent.ts`), policy, streamed chat route, and the governed action route with one-time approval tokens for gated writes.
- `src/openapi.json` — the host API contract (ENG-202): one derivation feeds the server's caller seam and the browser's client executor.
- `src/vendo/` — provider root, sandbox stage (in-flow ApprovalCard consent), the three surfaces (page `/vendo`, Cmd/Ctrl+K overlay, inbox slot), host-component descriptors, brand tokens.
- `vendo-sandbox/` — sandbox bundle entry + adapters binding the app's real components (`GmailEmailRow`, `GmailComposeChip`) via `installVendoHost`.
- `.vendo/` — `vendo init` output, hand-fixed (see `docs/superpowers/specs/2026-07-02-gmail-extraction-fidelity-findings.md`).

## What's real vs fake

- **Real:** server-backed inbox/starred/sent (survives reload; `POST /api/vendo/reset` reseeds), read view (mark-read/delete/star), compose → send, the agent acting through the app's API as the user with approval-gated writes, model-drafted replies, and REAL Slack posts via Composio (`vendo-demo`, #general).
- **Fake/static:** search bar (search exists as an agent tool instead), pagination arrows, category tabs, Drafts/Spam counts, remaining left-nav items.

## The demo beat

Type into Vendo, verbatim: *"Turn my unread emails into Tinder: swipe left to delete, swipe right to reply for me. Swipe up to send it to my team's Slack with a quick summary."* The agent generates a working swipe deck over the real unread mail; left = delete, right = model-drafted reply-send, up = real Slack summary — each gated by an approval card under the view.
