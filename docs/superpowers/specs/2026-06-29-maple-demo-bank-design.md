# Maple — Demo Neobank (Host App) Design

**Issue:** ENG-175 · D1 · Demo site + host bank app
**Demo concept:** ENG-172 · "The $87 Mystery"
**Date:** 2026-06-29

## Purpose

Build the host consumer neobank app that the Flowlet demo embeds into. This issue
delivers only the host: a believable, polished banking app, a real server/API layer
behind it, and the seed data the demo depends on. No agent logic, no Flowlet embed.
The app must look real enough that the audience believes it, with Brex/Mercury-grade
visual restraint, and it must behave like a real application — every screen's data
comes from the API over HTTP, not from direct fixture imports.

The seed data is load-bearing for the demo: it must contain the planted $87.00
DoorDash charge at 1:14 AM.

## Non-goals

- No Flowlet agent logic, no generative UI, no chat/assistant surface.
- No auth / login (single seeded user). Not production banking software — a demo host.
- No Gmail or other external integrations in this issue.
- The "real backend" is real in shape (HTTP REST, service layer, seeded store) but
  uses an in-memory store, not a hardened production database.

## Look & feel

- Near-monochrome: ink `#111` on warm white `#FBFBFA`, hairline borders `#ECEBE8`.
- Color used only for transaction amounts (red negative, green positive) and small
  positive/negative deltas. Everything structural stays monochrome.
- Generous whitespace, refined system sans typography, tight letter-spacing on numerals.
- Subtle data viz: thin line/area charts and simple category bars. No decorative gradients.
- Rounded cards (10–12px radius), 1px borders, minimal shadow.

## Tech stack

- Next.js (App Router) + TypeScript + Tailwind CSS.
- Hand-built components; no heavy UI kit. Lucide for icons.
- Backend = Next.js Route Handlers under `app/api/*` over a clean service/repository
  layer with a seeded in-memory store. The UI never imports seed data directly — it
  fetches from the API over HTTP, like a real app (SWR for client-side data fetching).
- Lives in the monorepo at `apps/demo-bank`, fully separate from `flowlet-core`.

## Monorepo layout

Repo is currently empty (fresh). Establish a minimal monorepo:

```
/
  apps/
    demo-bank/        # this issue — the Maple host app (Next.js + API)
  README.md
```

`flowlet-core` will be a sibling under `apps/` or `packages/` later; this issue does
not create or depend on it. Keep `demo-bank` self-contained.

## Server / API architecture

The host behaves like a real banking app: a backend owns the data and exposes it over
HTTP; the frontend is a client of that API.

```
apps/demo-bank/src/
  server/
    store.ts          # seeded in-memory store (module singleton), source of truth
    seed.ts           # deterministic seed: accounts, ~30 days of transactions
    accounts.ts       # repository: list/get accounts, account transactions
    transactions.ts   # repository: list (search/filter), get by id
    insights.ts       # repository: spending-by-category aggregation
  app/api/            # HTTP surface (Route Handlers) over the repositories
  lib/api-client.ts   # typed fetch client used by all UI
```

### REST endpoints

- `GET /api/profile` — persona (name, account summary)
- `GET /api/accounts` — all accounts
- `GET /api/accounts/:id` — one account
- `GET /api/accounts/:id/transactions` — that account's transactions
- `GET /api/transactions` — list; query params `search`, `category`, `accountId`, `limit`
- `GET /api/transactions/:id` — one transaction (the $87 DoorDash detail)
- `GET /api/cards` — card(s) for the account
- `GET /api/insights/spending` — category breakdown for the month

Conventions like a real API: JSON bodies, proper status codes (200 / 404 for missing
ids), consistent envelope (`{ data }` / `{ error }`), stable ids. Writes are out of
scope for this issue but the repository layer is structured to add them later (the
demo's "powerful action" will mutate through this same layer).

### Data fetching in the UI

All pages fetch through `lib/api-client.ts` (typed wrappers around `fetch`) so the
browser network tab shows real `/api/*` calls. No component imports `server/*` or
seed data directly. Loading and 404 states are handled.

## Persona & brand

- App name: **Maple**. Wordmark: black rounded-square "M" + "Maple".
- Account holder: **Yousef Helal**, personal account.
- Accounts: Checking ·· 4471, Savings ·· 8820.

## Pages / surface

1. **Home** (`/`)
   - Total balance + small month-over-month delta.
   - Balance trend line chart (last ~30 days).
   - Account summary cards (Checking, Savings).
   - Recent activity (latest ~6 transactions). DoorDash 1:14 AM is visible here.

2. **Accounts** (`/accounts`, `/accounts/[id]`)
   - List of accounts with balances.
   - Account detail: balance, account/routing (masked), its transaction list.

3. **Transactions** (`/transactions`, `/transactions/[id]`)
   - Full list: searchable by merchant, filterable by category/account, grouped by date.
   - Transaction detail: merchant, amount, exact timestamp, category, account, status,
     payment method, location, notes. The $87 DoorDash detail is the demo's anchor —
     it should look like a normal, slightly mysterious charge ("DOORDASH" descriptor,
     1:14 AM, no itemization — the blank the rest of the demo later fills in).

4. **Cards** (`/cards`)
   - Maple debit card visual + static controls (freeze toggle, limits) — non-functional,
     presentational only.

5. **Insights** (`/insights`)
   - Spending by category (bars), simple monthly summary. Derived from seed data.

Shared: left sidebar nav (Home, Accounts, Transactions, Cards, Insights) + account
switcher / profile footer. Responsive enough for a laptop on a projector.

## Data model

Shared types under `apps/demo-bank/src/server/` (also re-exported for the API client).

```ts
type Category =
  | "dining" | "groceries" | "coffee" | "transport" | "subscriptions"
  | "shopping" | "income" | "transfer" | "housing" | "other"

type Account = {
  id: string
  name: string            // "Maple Checking"
  kind: "checking" | "savings"
  mask: string            // "4471"
  balance: number         // cents
}

type Transaction = {
  id: string
  accountId: string
  merchant: string        // display name, e.g. "DoorDash"
  descriptor: string      // raw bank descriptor, e.g. "DOORDASH*ORDER 1140"
  amount: number          // cents, negative = debit
  timestamp: string       // ISO 8601 with local time, incl. the 1:14 AM charge
  category: Category
  status: "posted" | "pending"
  method: string          // "Maple Debit ·· 4471"
  location?: string       // "San Francisco, CA"
  notes?: string
}
```

### Seed data requirements

- ~30 days of activity across both accounts: paycheck deposits (2), rent, groceries
  (Whole Foods, Trader Joe's), coffee, rideshare (Uber/Lyft), subscriptions (Spotify,
  Netflix, iCloud), a few restaurants, transfers to savings. Realistic amounts and
  cadence so the month reads as a real person's spending.
- **The planted charge:** DoorDash, **−$87.00**, timestamp **1:14 AM**, category Dining,
  on Maple Checking. Descriptor reads like a real bank line (no itemization). Dated so it
  is the most recent / top-of-feed transaction for demo impact.
- Deterministic seed (no random at request time) so the demo is identical every run.
  Stable ids.

## Testing / verification

- App builds and runs (`next dev` / `next build`) with no type errors.
- API smoke test: each endpoint returns expected shape and status (200s, 404 for a
  missing id), and `GET /api/transactions/:id` for the DoorDash charge returns −$87.00
  at the 1:14 AM timestamp. A small test guards that the planted charge exists.
- Manual walkthrough: every page renders from live `/api/*` calls (visible in the
  network tab), nav works, the $87 DoorDash transaction is on Home and opens a detail
  page showing the 1:14 AM timestamp.
- Visual check against the approved mockup (monochrome, hairline borders, premium feel).

## Out of scope / later

- Flowlet embed, assistant UI, generative components (separate issue).
- Gmail receipt + Slack snitch, live order trigger, guardrails (separate issue).
- API write/mutation endpoints (the repository layer is shaped to add them later).
