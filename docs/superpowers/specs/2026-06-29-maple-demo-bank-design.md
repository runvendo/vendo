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
- Color used only for transaction amounts (red negative, green positive), small
  positive/negative deltas, and category accents in charts. Everything structural
  stays monochrome.
- Typography: **Inter** (variable), tight letter-spacing on headings, `tabular-nums`
  on all money so columns align. A clear type scale (display / title / body / caption).
- Generous whitespace, refined hierarchy, rounded cards (12–16px radius), 1px borders,
  soft layered shadows used sparingly for elevation (menus, modals, card hover).
- Subtle, real data viz: thin line/area trend charts, category donut, budget progress
  bars, sparklines. No decorative gradients; charts are restrained and legible.
- Premium micro-interactions: hover/active states on every interactive element, smooth
  200ms transitions, subtle row hover, focus rings, animated number/chart mount.

This must clear a high bar — it should be indistinguishable from a real, well-funded
neobank dashboard at a glance. Cut corners on data realism before visual polish.

## Tech stack

- Next.js (App Router) + TypeScript + Tailwind CSS.
- Hand-built component library (buttons, cards, tabs, table, modal/sheet, dropdown,
  toast, skeleton, badge, segmented control, command palette). No heavy UI kit; small
  primitives via Radix where it saves accessibility work (dialog, dropdown, tooltip).
- Inter via `next/font`. Lucide for icons. A small chart layer (lightweight, e.g.
  hand-rolled SVG + a minimal lib like Recharts only where it clearly helps).
- Framer Motion for restrained animation (number/chart mount, sheet/modal transitions).
- Backend = Next.js Route Handlers under `app/api/*` over a clean service/repository
  layer with a seeded in-memory store. The UI never imports seed data directly — it
  fetches from the API over HTTP, like a real app (SWR for client-side data fetching,
  with skeleton loading states).
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
    types.ts          # shared domain types
    store.ts          # seeded in-memory store (module singleton), source of truth
    seed.ts           # deterministic seed: accounts, ~150+ transactions, derived data
    accounts.ts       # repository: accounts, account transactions, statements
    transactions.ts   # repository: list (search/filter/sort/paginate), get by id
    cards.ts          # repository: cards + card transactions
    insights.ts       # repositories: spending, cashflow, budgets, recurring
    payments.ts       # repositories: payees, scheduled payments, goals
    notifications.ts  # repository: activity feed
  app/api/            # HTTP surface (Route Handlers) over the repositories
  components/         # design-system primitives + feature components
  lib/api-client.ts   # typed fetch client + SWR hooks used by all UI
```

### REST endpoints

- `GET /api/profile` — persona + summary (name, net worth, account count)
- `GET /api/accounts` — all accounts (with sparkline series)
- `GET /api/accounts/:id` — one account (incl. account/routing, APY, statements)
- `GET /api/accounts/:id/transactions` — that account's transactions
- `GET /api/transactions` — list; query `search`, `category`, `accountId`, `status`,
  `from`, `to`, `min`, `max`, `sort`, `limit`, `cursor` (pagination)
- `GET /api/transactions/:id` — one transaction (the $87 DoorDash detail)
- `GET /api/cards` — cards (physical + virtual) with masked details
- `GET /api/cards/:id/transactions` — transactions on a card
- `GET /api/insights/spending` — category breakdown for the month
- `GET /api/insights/cashflow` — money in/out series
- `GET /api/insights/budgets` — budgets with spent/limit
- `GET /api/insights/recurring` — detected subscriptions / recurring payments
- `GET /api/payees` — saved payees
- `GET /api/payments/scheduled` — upcoming & recurring payments
- `GET /api/goals` — savings goals with progress
- `GET /api/notifications` — activity / notification feed

Conventions like a real API: JSON bodies, proper status codes (200 / 404 for missing
ids, 400 for bad query), consistent envelope (`{ data }` / `{ error }`), pagination via
cursor, stable ids. Writes are out of scope for this issue but the repository layer is
structured to add them later (the demo's "powerful action" will mutate through this
same layer).

### Data fetching in the UI

All pages fetch through `lib/api-client.ts` (typed wrappers around `fetch`) so the
browser network tab shows real `/api/*` calls. No component imports `server/*` or
seed data directly. Loading and 404 states are handled.

## Persona & brand

- App name: **Maple**. Wordmark: black rounded-square "M" + "Maple".
- Account holder: **Yousef Helal**, personal account.
- Accounts: Checking ·· 4471, Savings ·· 8820.

## Pages / surface

A full neobank surface — richer than a skeleton, every page populated with believable
content. Routes:

**App shell (every page)**
- Left sidebar: brand, primary nav (Home, Accounts, Transactions, Cards, Payments,
  Insights), secondary (Activity, Settings), profile footer with account switcher.
- Top bar: page title, global search, **⌘K command palette**, notifications bell with
  unread dot + dropdown, quick-action buttons (Send, Request, Move money).
- Responsive: full sidebar on desktop, collapsible on narrow widths.

1. **Home** (`/`)
   - Greeting + total net worth across accounts, month-over-month delta.
   - Balance trend chart with range toggle (1W / 1M / 3M / 1Y / All).
   - Account summary cards (Checking, Savings, Credit, Investing) with mini sparklines.
   - Cashflow widget: money in vs. out this month.
   - Quick actions row (Send, Request, Move money, Pay bill, Deposit).
   - Recent activity (latest ~8) with merchant avatars. DoorDash 1:14 AM visible here.
   - Upcoming bills / scheduled payments. Spending-by-category mini donut.
   - Savings goals progress.

2. **Accounts** (`/accounts`, `/accounts/[id]`)
   - Overview: each account as a card (balance, type, mask, APY for savings, sparkline).
   - Account detail: large balance, account & routing numbers (masked, reveal toggle),
     interest/APY, this account's transaction list, "Statements & documents" section.

3. **Transactions** (`/transactions`, `/transactions/[id]`)
   - Rich list: merchant avatar + category icon, date grouping, running context.
   - Search; filters for date range, amount range, category, account, status; sort.
   - Pagination / load-more; CSV export button (presentational). Summary header
     (count + total for current filter).
   - Transaction detail: hero amount, merchant + logo, exact timestamp, category (editable
     UI), account, status **timeline** (authorized → posted), payment method, location
     with a small static map, notes, "report a problem" / "split" actions (presentational).
     The $87 DoorDash charge is the anchor — a normal, slightly mysterious line
     ("DOORDASH" descriptor, 1:14 AM, no itemization — the blank the rest of the demo fills).

4. **Cards** (`/cards`)
   - Card carousel: physical Maple debit + a virtual card, realistic card visuals.
   - Per-card: freeze toggle, spend limit control, masked number reveal, "add to wallet",
     recent transactions on that card. Controls are presentational (optimistic UI only).

5. **Payments / Move money** (`/payments`)
   - Tabs: Send, Request, Transfer between accounts, Pay bills.
   - Payees list, scheduled & recurring payments, recent transfers. Forms are
     presentational (no real money movement; writes are out of scope this issue).

6. **Insights** (`/insights`)
   - Spending by category (donut + ranked bars), month-over-month trend.
   - Budgets with progress bars (over/under), top merchants, recurring subscriptions
     detected from seed data, cashflow chart. All derived from seed data.

7. **Activity** (`/activity`)
   - Notification/event feed (deposits posted, low-balance alerts, card used, security).

8. **Settings** (`/settings`)
   - Profile, security toggles, linked accounts, preferences. Presentational.

Where a page exceeds this issue's needs, content can be lightly populated — but no page
should feel empty or obviously fake.

## Polish & interaction (the bar)

- **Loading:** every data surface has a tailored skeleton (not a spinner) while its
  `/api/*` call resolves; content fades/slides in on arrival.
- **States:** designed empty, zero, and 404 states. No raw error text.
- **Motion:** Framer Motion for sheet/modal/menu transitions, number count-up on
  balances, chart draw-on-mount. Restrained, ~150–250ms, respects reduced-motion.
- **Command palette (⌘K):** fuzzy nav + jump-to-transaction; reinforces "real app".
- **Toasts** for presentational actions (freeze card, copy account number, export).
- **Detail polish:** copy-to-clipboard on account/card numbers, hover tooltips,
  keyboard focus rings, sticky table headers, hover row affordances.
- **Money formatting:** one shared formatter, `tabular-nums`, correct signs/colors,
  cents handled as integers throughout.
- **Responsive:** works from ~1024px (projector/laptop) up; sidebar collapses gracefully.

## Data model

Shared types under `apps/demo-bank/src/server/types.ts` (re-exported for the API client).

```ts
type Category =
  | "dining" | "groceries" | "coffee" | "transport" | "subscriptions"
  | "shopping" | "income" | "transfer" | "housing" | "other"

type Account = {
  id: string
  name: string            // "Maple Checking"
  kind: "checking" | "savings" | "credit" | "investing"
  mask: string            // "4471"
  balance: number         // cents
  accountNumber: string   // masked full number
  routingNumber?: string
  apy?: number            // savings/credit
  sparkline: number[]     // recent balance series
}

type Transaction = {
  id: string
  accountId: string
  cardId?: string
  merchant: string        // display name, e.g. "DoorDash"
  descriptor: string      // raw bank descriptor, e.g. "DOORDASH*ORDER 1140"
  logo?: string           // asset/initials key for the merchant avatar
  amount: number          // cents, negative = debit
  timestamp: string       // ISO 8601 local time, incl. the 1:14 AM charge
  category: Category
  status: "posted" | "pending" | "authorized"
  statusTimeline: { state: string; at: string }[]
  method: string          // "Maple Debit ·· 4471"
  location?: string       // "San Francisco, CA"
  notes?: string
  recurringId?: string
}

type Card = {
  id: string; accountId: string
  type: "physical" | "virtual"
  network: "visa" | "mastercard"
  mask: string; expMonth: number; expYear: number
  frozen: boolean; spendLimit?: number
  design: string          // gradient/style key
}

type Budget = { category: Category; limit: number; spent: number }
type Goal = { id: string; name: string; target: number; saved: number; emoji: string }
type Payee = { id: string; name: string; kind: "person" | "biller"; mask?: string }
type ScheduledPayment = {
  id: string; payeeId: string; amount: number; nextDate: string
  cadence: "once" | "weekly" | "monthly"
}
type Recurring = {
  id: string; merchant: string; amount: number; cadence: "monthly" | "weekly"
  category: Category; nextDate: string
}
type Notification = {
  id: string; kind: "deposit" | "card" | "alert" | "security" | "transfer"
  title: string; body: string; at: string; read: boolean
}
```

### Seed data requirements

- Four accounts: Checking, Savings (with APY), a Credit card, and an Investing account,
  with believable balances that sum to a realistic net worth.
- **~60–90 days** of activity (so 1M/3M ranges and trend charts have real shape), ~150+
  transactions: biweekly paycheck deposits, rent/housing, groceries (Whole Foods, Trader
  Joe's, Safeway), coffee (Blue Bottle, Sightglass), rideshare (Uber, Lyft), transit,
  subscriptions (Spotify, Netflix, iCloud, ChatGPT, gym), restaurants & late-night food,
  shopping (Amazon, Apple), transfers to savings, a refund, a couple pending/authorized
  items. Realistic amounts, merchants, and cadence so the month reads as a real person.
- Derived data must be consistent: budgets, recurring/subscriptions, category breakdown,
  cashflow, and goals are all computed from (or aligned with) the transaction set.
- **The planted charge:** DoorDash, **−$87.00**, timestamp **1:14 AM**, category dining,
  on Maple Checking, with a status timeline. Descriptor reads like a real bank line (no
  itemization). Dated as the most recent / top-of-feed transaction for demo impact.
- Deterministic seed (no random at request time) so the demo is identical every run.
  Stable ids. A seeded PRNG may be used at build/seed time for variety, never per request.

## Testing / verification

- App builds and runs (`next dev` / `next build`) with no type/lint errors.
- API smoke test: each endpoint returns the expected shape and status (200s, 404 for a
  missing id, 400 for bad query); `GET /api/transactions/:id` for the DoorDash charge
  returns −$87.00 at the 1:14 AM timestamp. A test guards that the planted charge exists
  and that derived totals (budgets/insights) reconcile with the transaction set.
- Manual walkthrough: every page renders from live `/api/*` calls (visible in the
  network tab) with skeletons → content, nav + ⌘K work, the $87 DoorDash transaction is
  on Home and opens a detail page showing the 1:14 AM timestamp.
- Visual QA against the approved look: monochrome, hairline borders, Inter, aligned
  numerals, hover/focus states, no empty-feeling pages. Screenshot key pages and review.

## Out of scope / later

- Flowlet embed, assistant UI, generative components (separate issue).
- Gmail receipt + Slack snitch, live order trigger, guardrails (separate issue).
- API write/mutation endpoints (the repository layer is shaped to add them later).
