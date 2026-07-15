# ENG-211 browser verification

Refreshed on 2026-07-14 with headless Chromium against both real demo dev servers and the real Anthropic streaming transport (no mocked model or wire). Maple and Cadence both mount `<VendoThread />` without a hardcoded `threadId`, so this evidence exercises the true default path.

For each demo, `default-path.mjs` sends `My name is Farouk and I bank here for my bakery.`, then `What is my name?`, and proves:

- turn 1 sends no `threadId` and receives a minted `thr_...` response header;
- turn 2 sends that same minted id and receives it again;
- one stored thread contains all four user/assistant messages;
- the second answer remembers Farouk; and
- the page logs no console errors or uncaught page errors.

The refreshed evidence is `maple-turn-1.png`, `maple-turn-2.png`, `cadence-turn-1.png`, and `cadence-turn-2.png`.

## Run it

From the repository root, install dependencies and load the demo keys without printing them:

```sh
pnpm install
set -a
source /Users/yousefh/orca/workspaces/flowlet/.env
set +a
```

Keep that environment in two terminals and start the demos:

```sh
pnpm --filter demo-bank dev --port 3020
pnpm --filter demo-accounting dev --port 3010
```

Then run the proof from the repository root:

```sh
node docs/verification/eng-211/default-path.mjs
```

The script exits nonzero on any request-id, response-id, memory, persistence, or browser-error mismatch and overwrites the four screenshots on success.

## Stale supplied ids

The headless hook now validates a supplied id through `GET /threads` summaries before loading detail. If the id is absent, it does not issue the noisy `GET /threads/:id` 404: messages remain empty, the returned effective `threadId` transitions from the supplied value to `undefined`, and the next turn omits the stale id so the server can mint and return a fresh one. `packages/ui/test/hooks.test.tsx` covers that transition, the existing-id history path, the default path, the request bodies, and the absence of surfaced or console errors.
