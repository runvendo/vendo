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

## Out of scope (this issue)

- The Flowlet embed and agent
- Gmail receipt lookup
- Slack integration
- API writes and mutations

The repository layer is shaped to add writes later, but only reads exist today. All form, card, and settings controls are presentational.
