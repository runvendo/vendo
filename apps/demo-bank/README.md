# Maple

Maple is a demo consumer neobank. It is the host app for the Flowlet "$87 Mystery" product demo: a polished, believable banking UI that the Flowlet agent embeds into. It is disposable and self-contained, kept separate from flowlet-core so it can be reshaped or thrown away without touching the core product.

## Stack

- Next.js 16 (App Router)
- TypeScript
- Tailwind v4
- SWR for data fetching
- Framer Motion for animation
- Recharts for charts
- Radix UI primitives
- Vitest for tests

## Run it

```bash
cd apps/demo-bank
npm install
npm run dev
```

Open http://localhost:3000.

```bash
npm run build   # production build
npm test        # vitest
```

## Architecture

Every screen is backed by a real HTTP API. The UI never imports seed data directly. The flow:

```
seeded in-memory store          src/server/store.ts + src/server/seed.ts
        ->
repositories                    src/server/{accounts,transactions,cards,insights,payments,notifications}.ts
        ->
Route Handlers                  src/app/api/**
        ->
typed client + SWR hooks        src/lib/api-client.ts + src/lib/hooks.ts
        ->
pages                           src/app/**
```

The store is seeded once in memory, deterministically, via a seeded PRNG in `src/server/prng.ts`. Repositories read from the store and apply filtering, sorting, and pagination. Route Handlers expose them under `/api/*`. The browser fetches those endpoints over HTTP through the typed client and SWR hooks. Pages never reach into the seed directly.

## API endpoints

- `GET /api/profile`
- `GET /api/accounts`
- `GET /api/accounts/:id`
- `GET /api/accounts/:id/transactions`
- `GET /api/transactions` (query params: `search`, `category`, `accountId`, `status`, `from`, `to`, `min`, `max`, `sort`, `limit`, `cursor`)
- `GET /api/transactions/:id`
- `GET /api/cards`
- `GET /api/cards/:id/transactions`
- `GET /api/insights/spending`
- `GET /api/insights/cashflow`
- `GET /api/insights/budgets`
- `GET /api/insights/recurring`
- `GET /api/payees`
- `GET /api/payments/scheduled`
- `GET /api/goals`
- `GET /api/notifications`

All `/api/*` routes are dynamic (server-rendered on demand).

## Pages

Home, Accounts, Transactions, Cards, Payments, Insights, Activity, Settings.

## The planted charge

The demo anchors on one transaction: `txn_doordash_87`, an $87.00 DoorDash charge at 1:14 AM on Maple Checking (`amount: -8700`, `category: dining`, descriptor `DOORDASH*ORDER 8742 CA`). It is the most recent transaction in the seed and the thing the Flowlet "$87 Mystery" demo investigates. The seed is deterministic, so the charge and surrounding data are identical on every run.

## Flowlet sandbox and generated views (Tier 2.5)

The agent can emit novel React views, not just catalog components. The path:

- The agent calls `render_view` with a `GeneratedPayload` (a `components` map of generated code). That becomes a `kind: "generated"` UI node, which `SandboxStage` mounts into the egress-jailed stage. The stage loads the components host bundle plus the React shim, copied into `public/flowlet/` by the `predev`/`prebuild` hook (`scripts/copy-flowlet-sandbox.mjs`).
- The demo runs a real guardrail policy (`src/flowlet/policy.ts`), replacing the old allow-all. Render tools plus in-process reads/rules (`render_ui`, `render_view`, `get_transactions`, `set_rule`) and read-shaped Composio tools (FETCH, GET, LIST, SEARCH, FIND, READ) resolve to `allow`. Write-shaped or unknown tools resolve to `approve`.
- Actions from a sandbox component (`flowlet.dispatch`) route through `POST /api/flowlet/action`, which runs them through the SAME `demoPolicy` before executing.

### Known limitations

1. The action route's approval re-POST is trusted: the client sends `approved: true`. Acceptable for this local-only demo; a production build needs a server-side approval token.
2. Approve-gated actions have no in-process executor in this demo, so clicking "Allow" on the sandbox approval prompt 404s. The approval UI is effectively vestigial for the demo's toolset. The intended sandbox action is `set_rule`, which is allowed and executes directly.
3. A denied sandbox `dispatch()` resolves `undefined` to the generated component rather than rejecting: the runtime's direct-reply path only propagates `result`, not errors. The server never executes the denied action, so this is a UX/semantics gap, not a security hole.
4. The loose Tier 2 `HtmlApp` iframe (full-document generated apps) is unchanged and still lacks the egress jail. A documented follow-up, out of scope for Tier 2.5.

## Out of scope (this issue)

- The Flowlet embed and agent
- Gmail receipt lookup
- Slack integration
- API writes and mutations

The repository layer is shaped to add writes later, but only reads exist today. All form, card, and settings controls are presentational.
