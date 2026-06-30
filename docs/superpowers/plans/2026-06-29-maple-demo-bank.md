# Maple Demo Neobank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Maple — a polished, believable consumer neobank web app (the host for the Flowlet "$87 Mystery" demo) with a real HTTP API backend, rich seed data including the planted $87 / 1:14 AM DoorDash charge, and a full multi-page UI.

**Architecture:** Next.js (App Router) single app at `apps/demo-bank`. A backend layer (seeded in-memory store → repositories → Route Handlers under `app/api/*`) owns all data and exposes ~17 REST endpoints. The UI never imports seed data directly; it fetches over HTTP via a typed client + SWR hooks, with skeleton loading states. Domain logic (money math, seed determinism, filtering/pagination, derived aggregates) is TDD'd with Vitest. UI is built to an explicit polish bar and verified by screenshot.

**Tech Stack:** Next.js 15 (App Router) · TypeScript · Tailwind CSS · SWR · Framer Motion · Recharts · Radix primitives (dialog/dropdown/tooltip/switch/tabs) · cmdk · lucide-react · Vitest.

**Spec:** `docs/superpowers/specs/2026-06-29-maple-demo-bank-design.md`

---

## Conventions

- **Money is integer cents everywhere.** Only format at the view boundary.
- **Deterministic seed.** A seeded PRNG generates variety at seed time only — never per request. Dates are computed relative to a single `anchor` Date captured once at store init (default `new Date()`, injectable in tests) so the data always looks current but is stable within a run.
- **API envelope:** success `{ data: ... }`, error `{ error: { message, code } }`. Status 200/404/400.
- **Commits:** one per task (or per logical step), conventional-commit style. End every commit message body with:
  `Claude-Session: https://claude.ai/code/session_01JauZhs9z5TMYLGuHW1H7LC`
- **Test command:** `cd apps/demo-bank && npx vitest run` (backend/logic). UI verified via `npm run dev` + screenshot.

---

## File Structure

```
apps/demo-bank/
  package.json  tsconfig.json  next.config.ts  vitest.config.ts  postcss.config.mjs
  src/
    app/
      layout.tsx  globals.css
      page.tsx                         # Home
      accounts/page.tsx  accounts/[id]/page.tsx
      transactions/page.tsx  transactions/[id]/page.tsx
      cards/page.tsx
      payments/page.tsx
      insights/page.tsx
      activity/page.tsx
      settings/page.tsx
      api/
        profile/route.ts
        accounts/route.ts  accounts/[id]/route.ts  accounts/[id]/transactions/route.ts
        transactions/route.ts  transactions/[id]/route.ts
        cards/route.ts  cards/[id]/transactions/route.ts
        insights/spending/route.ts  insights/cashflow/route.ts
        insights/budgets/route.ts  insights/recurring/route.ts
        payees/route.ts  payments/scheduled/route.ts
        goals/route.ts  notifications/route.ts
    server/
      types.ts  prng.ts  store.ts  seed.ts
      accounts.ts  transactions.ts  cards.ts  insights.ts  payments.ts  notifications.ts
      __tests__/*.test.ts
    lib/
      money.ts  money.test.ts  cn.ts  api-client.ts  hooks.ts  format.ts
    components/
      ui/        # primitives: button, card, badge, skeleton, tabs, sheet, dropdown, tooltip, switch, toast, segmented, command-palette
      shell/     # sidebar, topbar, app-shell
      charts/    # area-trend, donut, bars, sparkline
      <feature components per page>
```

---

## Task 1: Scaffold the monorepo and Next.js app

**Files:**
- Create: `apps/demo-bank/` (via create-next-app), root `package.json` (workspaces), root `README.md` (update)

- [ ] **Step 1: Create root workspace manifest**

Create `package.json` at repo root:

```json
{
  "name": "flowlet-monorepo",
  "private": true,
  "workspaces": ["apps/*", "packages/*"]
}
```

- [ ] **Step 2: Scaffold the Next.js app**

Run:
```bash
npx create-next-app@latest apps/demo-bank \
  --typescript --tailwind --app --src-dir --eslint \
  --import-alias "@/*" --no-turbopack --use-npm
```
Expected: `apps/demo-bank` created with `src/app`, Tailwind wired, dev server available.

- [ ] **Step 3: Add dependencies**

Run:
```bash
cd apps/demo-bank && npm install swr framer-motion recharts cmdk lucide-react clsx tailwind-merge \
  @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-tooltip \
  @radix-ui/react-switch @radix-ui/react-tabs && npm install -D vitest @vitejs/plugin-react jsdom
```

- [ ] **Step 4: Add Vitest config**

Create `apps/demo-bank/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
})
```
Add to `apps/demo-bank/package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 5: Verify dev server + test runner boot**

Run: `cd apps/demo-bank && npm run dev` → open http://localhost:3000, confirm default page renders. Stop. Run `npx vitest run` → expect "No test files found" (exit 0 or benign).

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "chore: scaffold demo-bank Next.js app and monorepo workspace"
```

---

## Task 2: Money formatting (TDD)

**Files:**
- Create: `apps/demo-bank/src/lib/money.ts`
- Test: `apps/demo-bank/src/lib/money.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/money.test.ts`:
```ts
import { describe, it, expect } from "vitest"
import { formatUSD, formatAmount } from "./money"

describe("money", () => {
  it("formats absolute amounts", () => {
    expect(formatUSD(8700)).toBe("$87.00")
    expect(formatUSD(123456)).toBe("$1,234.56")
    expect(formatUSD(0)).toBe("$0.00")
    expect(formatUSD(-8700)).toBe("$87.00")
  })
  it("formats signed amounts for transactions", () => {
    expect(formatAmount(-8700)).toBe("-$87.00")
    expect(formatAmount(120000)).toBe("+$1,200.00")
    expect(formatAmount(0)).toBe("$0.00")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/money.test.ts`
Expected: FAIL (module not found / functions undefined).

- [ ] **Step 3: Implement**

`src/lib/money.ts`:
```ts
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/** Absolute dollar amount from integer cents, e.g. 123456 -> "$1,234.56". */
export function formatUSD(cents: number): string {
  return usd.format(Math.abs(cents) / 100)
}

/** Signed amount for transaction rows: debit "-$87.00", credit "+$1,200.00", zero "$0.00". */
export function formatAmount(cents: number): string {
  if (cents === 0) return formatUSD(0)
  const body = formatUSD(cents)
  return cents < 0 ? `-${body}` : `+${body}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/money.test.ts` → Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/money.ts src/lib/money.test.ts && git commit -m "feat: integer-cents money formatters with tests"
```

---

## Task 3: Domain types + seeded PRNG

**Files:**
- Create: `apps/demo-bank/src/server/types.ts`, `apps/demo-bank/src/server/prng.ts`
- Test: `apps/demo-bank/src/server/__tests__/prng.test.ts`

- [ ] **Step 1: Write the failing PRNG test**

`src/server/__tests__/prng.test.ts`:
```ts
import { describe, it, expect } from "vitest"
import { mulberry32 } from "../prng"

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42); const b = mulberry32(42)
    const seqA = [a(), a(), a()]; const seqB = [b(), b(), b()]
    expect(seqA).toEqual(seqB)
  })
  it("returns values in [0,1)", () => {
    const r = mulberry32(7)
    for (let i = 0; i < 100; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1) }
  })
})
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/server/__tests__/prng.test.ts` → FAIL.

- [ ] **Step 3: Implement types and prng**

`src/server/types.ts`:
```ts
export type Category =
  | "dining" | "groceries" | "coffee" | "transport" | "subscriptions"
  | "shopping" | "income" | "transfer" | "housing" | "other"

export type AccountKind = "checking" | "savings" | "credit" | "investing"

export interface Account {
  id: string
  name: string
  kind: AccountKind
  mask: string
  balance: number            // cents
  accountNumber: string      // masked
  routingNumber?: string
  apy?: number
  sparkline: number[]
}

export type TxStatus = "posted" | "pending" | "authorized"

export interface Transaction {
  id: string
  accountId: string
  cardId?: string
  merchant: string
  descriptor: string
  logo?: string              // initials/key for avatar
  amount: number             // cents, negative = debit
  timestamp: string          // ISO 8601
  category: Category
  status: TxStatus
  statusTimeline: { state: string; at: string }[]
  method: string
  location?: string
  notes?: string
  recurringId?: string
}

export interface Card {
  id: string
  accountId: string
  type: "physical" | "virtual"
  network: "visa" | "mastercard"
  mask: string
  expMonth: number
  expYear: number
  frozen: boolean
  spendLimit?: number
  design: string
}

export interface Budget { category: Category; limit: number; spent: number }
export interface Goal { id: string; name: string; target: number; saved: number; emoji: string }
export interface Payee { id: string; name: string; kind: "person" | "biller"; mask?: string }
export interface ScheduledPayment {
  id: string; payeeId: string; payeeName: string; amount: number; nextDate: string
  cadence: "once" | "weekly" | "monthly"
}
export interface Recurring {
  id: string; merchant: string; amount: number; cadence: "monthly" | "weekly"
  category: Category; nextDate: string
}
export interface Notification {
  id: string; kind: "deposit" | "card" | "alert" | "security" | "transfer"
  title: string; body: string; at: string; read: boolean
}
export interface SpendingSlice { category: Category; amount: number }
export interface CashflowPoint { label: string; in: number; out: number }
export interface Profile {
  name: string; email: string; netWorth: number; accountCount: number; avatarInitials: string
}
```

`src/server/prng.ts`:
```ts
/** Deterministic PRNG. Same seed -> same sequence. Values in [0,1). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return function () {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
```

- [ ] **Step 4: Run to verify pass** — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/server/types.ts src/server/prng.ts src/server/__tests__/prng.test.ts
git commit -m "feat: domain types and deterministic PRNG"
```

---

## Task 4: Seed data + store (TDD)

**Files:**
- Create: `apps/demo-bank/src/server/seed.ts`, `apps/demo-bank/src/server/store.ts`
- Test: `apps/demo-bank/src/server/__tests__/seed.test.ts`

The seed builds 4 accounts, ~150 transactions over 90 days from an injectable `anchor`, the planted DoorDash charge, plus cards, payees, scheduled payments, goals, notifications. Derived aggregates (budgets/recurring/spending/cashflow) are computed by repositories in Task 6, not stored.

- [ ] **Step 1: Write the failing seed test**

`src/server/__tests__/seed.test.ts`:
```ts
import { describe, it, expect } from "vitest"
import { buildSeed } from "../seed"

const anchor = new Date("2026-06-29T12:00:00-07:00")

describe("buildSeed", () => {
  const data = buildSeed(anchor)

  it("creates four accounts including checking and savings", () => {
    const kinds = data.accounts.map(a => a.kind)
    expect(kinds).toContain("checking")
    expect(kinds).toContain("savings")
    expect(data.accounts.length).toBe(4)
  })

  it("generates a substantial, deterministic transaction history", () => {
    const a = buildSeed(anchor); const b = buildSeed(anchor)
    expect(a.transactions.length).toBeGreaterThanOrEqual(120)
    expect(a.transactions.map(t => t.id)).toEqual(b.transactions.map(t => t.id))
  })

  it("plants the $87 DoorDash charge at 1:14 AM on checking", () => {
    const dd = data.transactions.find(t => t.merchant === "DoorDash" && t.amount === -8700)
    expect(dd).toBeTruthy()
    const checking = data.accounts.find(a => a.kind === "checking")!
    expect(dd!.accountId).toBe(checking.id)
    expect(dd!.category).toBe("dining")
    const d = new Date(dd!.timestamp)
    expect(d.getHours()).toBe(1)
    expect(d.getMinutes()).toBe(14)
    expect(dd!.descriptor).toMatch(/DOORDASH/i)
  })

  it("makes the DoorDash charge the most recent transaction", () => {
    const sorted = [...data.transactions].sort((x, y) => +new Date(y.timestamp) - +new Date(x.timestamp))
    expect(sorted[0].merchant).toBe("DoorDash")
  })

  it("includes cards, payees, goals and notifications", () => {
    expect(data.cards.length).toBeGreaterThanOrEqual(2)
    expect(data.payees.length).toBeGreaterThan(0)
    expect(data.goals.length).toBeGreaterThan(0)
    expect(data.notifications.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run to verify fail** — FAIL (no `buildSeed`).

- [ ] **Step 3: Implement the seed**

`src/server/seed.ts`:
```ts
import { mulberry32 } from "./prng"
import type {
  Account, Transaction, Card, Payee, ScheduledPayment, Goal, Notification, Category,
} from "./types"

export interface SeedData {
  accounts: Account[]
  transactions: Transaction[]
  cards: Card[]
  payees: Payee[]
  scheduled: ScheduledPayment[]
  goals: Goal[]
  notifications: Notification[]
}

const CHECKING = "acc_checking"
const SAVINGS = "acc_savings"
const CREDIT = "acc_credit"
const INVEST = "acc_investing"

function iso(d: Date) { return d.toISOString() }
function daysAgo(anchor: Date, n: number, h = 12, m = 0) {
  const d = new Date(anchor); d.setDate(d.getDate() - n); d.setHours(h, m, 0, 0); return d
}
function initials(name: string) {
  return name.replace(/[^a-zA-Z ]/g, "").split(" ").filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase()
}

// Recurring merchant templates: [merchant, category, dayOfMonth, cents(+/-)]
const RECURRING: { merchant: string; category: Category; dom: number; cents: number; descriptor: string }[] = [
  { merchant: "Equinox", category: "subscriptions", dom: 1, cents: -28500, descriptor: "EQUINOX SF" },
  { merchant: "Rent — Mission St", category: "housing", dom: 1, cents: -285000, descriptor: "ACH RENT MISSION" },
  { merchant: "Spotify", category: "subscriptions", dom: 4, cents: -1199, descriptor: "SPOTIFY USA" },
  { merchant: "Netflix", category: "subscriptions", dom: 7, cents: -1549, descriptor: "NETFLIX.COM" },
  { merchant: "iCloud+", category: "subscriptions", dom: 9, cents: -299, descriptor: "APPLE.COM/BILL" },
  { merchant: "ChatGPT", category: "subscriptions", dom: 12, cents: -2000, descriptor: "OPENAI CHATGPT" },
]

// One-off merchant pool: [merchant, category, [minCents, maxCents]]
const POOL: { merchant: string; category: Category; min: number; max: number; descriptor: string }[] = [
  { merchant: "Whole Foods Market", category: "groceries", min: 2200, max: 9400, descriptor: "WHOLEFDS SFO" },
  { merchant: "Trader Joe's", category: "groceries", min: 1800, max: 6200, descriptor: "TRADER JOE'S #182" },
  { merchant: "Blue Bottle Coffee", category: "coffee", min: 525, max: 1400, descriptor: "BLUE BOTTLE" },
  { merchant: "Sightglass Coffee", category: "coffee", min: 500, max: 1200, descriptor: "SIGHTGLASS" },
  { merchant: "Uber", category: "transport", min: 850, max: 3800, descriptor: "UBER *TRIP" },
  { merchant: "Lyft", category: "transport", min: 700, max: 3200, descriptor: "LYFT *RIDE" },
  { merchant: "Amazon", category: "shopping", min: 1200, max: 14500, descriptor: "AMZN MKTP US" },
  { merchant: "Apple Store", category: "shopping", min: 2900, max: 32900, descriptor: "APPLE STORE R052" },
  { merchant: "Tartine Bakery", category: "dining", min: 1400, max: 4800, descriptor: "TARTINE" },
  { merchant: "Philz Coffee", category: "coffee", min: 500, max: 1500, descriptor: "PHILZ COFFEE" },
  { merchant: "Chipotle", category: "dining", min: 1100, max: 2600, descriptor: "CHIPOTLE 2244" },
  { merchant: "Shell", category: "transport", min: 3500, max: 7200, descriptor: "SHELL OIL" },
]

function timeline(status: Transaction["status"], ts: string) {
  const t = new Date(ts)
  const authoredAt = new Date(t.getTime() - 36 * 3600 * 1000).toISOString()
  if (status === "posted") return [{ state: "Authorized", at: authoredAt }, { state: "Posted", at: ts }]
  if (status === "authorized") return [{ state: "Authorized", at: ts }]
  return [{ state: "Pending", at: ts }]
}

export function buildSeed(anchor: Date = new Date()): SeedData {
  const rand = mulberry32(20260629)
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)]
  const between = (min: number, max: number) => -(min + Math.floor(rand() * (max - min)))

  const txns: Transaction[] = []
  let n = 0
  const add = (t: Omit<Transaction, "id" | "logo" | "statusTimeline" | "method"> & Partial<Transaction>) => {
    const id = t.id ?? `txn_${String(++n).padStart(4, "0")}`
    txns.push({
      id, logo: initials(t.merchant), method: t.method ?? "Maple Debit ·· 4471",
      statusTimeline: timeline(t.status, t.timestamp), ...t,
    } as Transaction)
  }

  // 90 days of history
  for (let day = 90; day >= 1; day--) {
    // biweekly paycheck (every 14 days)
    if (day % 14 === 0) {
      add({ accountId: CHECKING, merchant: "Acme Corp Payroll", descriptor: "ACME CORP DIR DEP",
        amount: 642000, timestamp: iso(daysAgo(anchor, day, 9, 2)), category: "income", status: "posted",
        method: "ACH deposit" })
      // transfer to savings the same day
      add({ accountId: CHECKING, merchant: "Transfer to Savings", descriptor: "INTERNAL XFER",
        amount: -100000, timestamp: iso(daysAgo(anchor, day, 9, 5)), category: "transfer", status: "posted",
        method: "Internal transfer" })
      add({ accountId: SAVINGS, merchant: "Transfer from Checking", descriptor: "INTERNAL XFER",
        amount: 100000, timestamp: iso(daysAgo(anchor, day, 9, 5)), category: "transfer", status: "posted",
        method: "Internal transfer" })
    }
    // 1-3 discretionary purchases per day, weighted
    const count = rand() < 0.25 ? 0 : rand() < 0.6 ? 1 : rand() < 0.9 ? 2 : 3
    for (let i = 0; i < count; i++) {
      const m = pick(POOL)
      const hour = 8 + Math.floor(rand() * 13)
      add({ accountId: rand() < 0.2 ? CREDIT : CHECKING, merchant: m.merchant, descriptor: m.descriptor,
        amount: between(m.min, m.max), timestamp: iso(daysAgo(anchor, day, hour, Math.floor(rand() * 60))),
        category: m.category, status: "posted", location: "San Francisco, CA",
        cardId: rand() < 0.2 ? "card_virtual" : "card_physical" })
    }
  }

  // recurring monthly charges across the last 3 month boundaries
  for (let monthsBack = 2; monthsBack >= 0; monthsBack--) {
    for (const r of RECURRING) {
      const d = new Date(anchor); d.setMonth(d.getMonth() - monthsBack); d.setDate(r.dom); d.setHours(6, 0, 0, 0)
      if (d <= anchor && d >= daysAgo(anchor, 92)) {
        add({ accountId: CHECKING, merchant: r.merchant, descriptor: r.descriptor, amount: r.cents,
          timestamp: iso(d), category: r.category, status: "posted",
          recurringId: `rec_${r.merchant.toLowerCase().replace(/[^a-z]/g, "")}` })
      }
    }
  }

  // a refund (positive) a week ago
  add({ accountId: CHECKING, merchant: "Amazon", descriptor: "AMZN Refund", amount: 3499,
    timestamp: iso(daysAgo(anchor, 7, 14, 22)), category: "shopping", status: "posted" })

  // a couple pending/authorized recent items (yesterday)
  add({ accountId: CHECKING, merchant: "Whole Foods Market", descriptor: "WHOLEFDS SFO", amount: -5218,
    timestamp: iso(daysAgo(anchor, 1, 18, 40)), category: "groceries", status: "posted" })
  add({ accountId: CREDIT, merchant: "United Airlines", descriptor: "UNITED 016", amount: -41800,
    timestamp: iso(daysAgo(anchor, 1, 11, 5)), category: "transport", status: "authorized", cardId: "card_virtual" })

  // THE PLANTED CHARGE — most recent, 1:14 AM today, $87.00, DoorDash, checking
  const dd = new Date(anchor); dd.setHours(1, 14, 0, 0)
  add({ id: "txn_doordash_87", accountId: CHECKING, cardId: "card_physical",
    merchant: "DoorDash", descriptor: "DOORDASH*ORDER 8742 CA", amount: -8700,
    timestamp: iso(dd), category: "dining", status: "posted", location: "San Francisco, CA",
    method: "Maple Debit ·· 4471" })

  // Sort newest first for stable presentation
  txns.sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))

  const accounts: Account[] = [
    { id: CHECKING, name: "Maple Checking", kind: "checking", mask: "4471", balance: 941220,
      accountNumber: "•••• •••• 4471", routingNumber: "•••••• 021", sparkline: spark(rand, 941220) },
    { id: SAVINGS, name: "Maple Savings", kind: "savings", mask: "8820", balance: 2814135, apy: 4.25,
      accountNumber: "•••• •••• 8820", routingNumber: "•••••• 021", sparkline: spark(rand, 2814135) },
    { id: CREDIT, name: "Maple Credit", kind: "credit", mask: "0934", balance: -128840, apy: 0,
      accountNumber: "•••• •••• 0934", sparkline: spark(rand, 128840) },
    { id: INVEST, name: "Maple Invest", kind: "investing", mask: "5567", balance: 1864200,
      accountNumber: "•••• •••• 5567", sparkline: spark(rand, 1864200) },
  ]

  const cards: Card[] = [
    { id: "card_physical", accountId: CHECKING, type: "physical", network: "visa", mask: "4471",
      expMonth: 8, expYear: 28, frozen: false, spendLimit: 500000, design: "graphite" },
    { id: "card_virtual", accountId: CREDIT, type: "virtual", network: "visa", mask: "0934",
      expMonth: 3, expYear: 27, frozen: false, spendLimit: 250000, design: "amber" },
  ]

  const payees: Payee[] = [
    { id: "pay_jordan", name: "Jordan Avery", kind: "person", mask: "venmo" },
    { id: "pay_landlord", name: "Mission St Property", kind: "biller", mask: "ACH" },
    { id: "pay_pge", name: "PG&E", kind: "biller", mask: "utility" },
    { id: "pay_mom", name: "Mom", kind: "person" },
  ]

  const scheduled: ScheduledPayment[] = [
    { id: "sch_rent", payeeId: "pay_landlord", payeeName: "Mission St Property", amount: -285000,
      nextDate: iso(nextDom(anchor, 1)), cadence: "monthly" },
    { id: "sch_pge", payeeId: "pay_pge", payeeName: "PG&E", amount: -8640,
      nextDate: iso(nextDom(anchor, 15)), cadence: "monthly" },
  ]

  const goals: Goal[] = [
    { id: "goal_japan", name: "Japan trip", target: 500000, saved: 312000, emoji: "🗾" },
    { id: "goal_emergency", name: "Emergency fund", target: 1000000, saved: 740000, emoji: "🛟" },
    { id: "goal_mac", name: "New MacBook", target: 250000, saved: 90000, emoji: "💻" },
  ]

  const notifications: Notification[] = [
    { id: "ntf_1", kind: "card", title: "Card used at DoorDash", body: "$87.00 · Maple Debit ·· 4471",
      at: iso(dd), read: false },
    { id: "ntf_2", kind: "deposit", title: "Paycheck deposited", body: "$6,420.00 from Acme Corp Payroll",
      at: iso(daysAgo(anchor, 0, 9, 2)), read: false },
    { id: "ntf_3", kind: "alert", title: "Unusual late-night spend", body: "A purchase posted at 1:14 AM",
      at: iso(dd), read: false },
    { id: "ntf_4", kind: "security", title: "New device signed in", body: "MacBook Pro · San Francisco",
      at: iso(daysAgo(anchor, 2, 22, 10)), read: true },
  ]

  return { accounts, transactions: txns, cards, payees, scheduled, goals, notifications }
}

function spark(rand: () => number, end: number): number[] {
  const pts: number[] = []; let v = end * (0.85 + rand() * 0.1)
  for (let i = 0; i < 24; i++) { v += (rand() - 0.45) * end * 0.03; pts.push(Math.round(v)) }
  pts.push(end); return pts
}
function nextDom(anchor: Date, dom: number): Date {
  const d = new Date(anchor); d.setDate(dom); d.setHours(6, 0, 0, 0)
  if (d <= anchor) d.setMonth(d.getMonth() + 1); return d
}
```

`src/server/store.ts`:
```ts
import { buildSeed, type SeedData } from "./seed"

// Module singleton — seeded once per server process at first import.
let cache: SeedData | null = null

export function getStore(): SeedData {
  if (!cache) cache = buildSeed(new Date())
  return cache
}

// Test helper: reseed with a fixed anchor for deterministic assertions.
export function __reseed(anchor: Date): SeedData {
  cache = buildSeed(anchor); return cache
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/server/__tests__/seed.test.ts` → PASS. Fix generation until counts/asserts hold.

- [ ] **Step 5: Commit**
```bash
git add src/server/seed.ts src/server/store.ts src/server/__tests__/seed.test.ts
git commit -m "feat: deterministic seed data with planted $87 DoorDash charge"
```

---

## Task 5: Transaction repository — filter/sort/paginate (TDD)

**Files:**
- Create: `apps/demo-bank/src/server/transactions.ts`, `apps/demo-bank/src/server/accounts.ts`
- Test: `apps/demo-bank/src/server/__tests__/transactions.test.ts`

- [ ] **Step 1: Write the failing test**

`src/server/__tests__/transactions.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest"
import { __reseed } from "../store"
import { listTransactions, getTransaction } from "../transactions"

beforeAll(() => __reseed(new Date("2026-06-29T12:00:00-07:00")))

describe("listTransactions", () => {
  it("returns newest first and paginates by cursor", () => {
    const p1 = listTransactions({ limit: 10 })
    expect(p1.data.length).toBe(10)
    expect(+new Date(p1.data[0].timestamp)).toBeGreaterThanOrEqual(+new Date(p1.data[1].timestamp))
    expect(p1.nextCursor).toBeTruthy()
    const p2 = listTransactions({ limit: 10, cursor: p1.nextCursor! })
    expect(p2.data[0].id).not.toBe(p1.data[0].id)
  })
  it("filters by search, category, account and amount range", () => {
    expect(listTransactions({ search: "doordash" }).data.some(t => t.merchant === "DoorDash")).toBe(true)
    expect(listTransactions({ category: "dining" }).data.every(t => t.category === "dining")).toBe(true)
    expect(listTransactions({ accountId: "acc_savings" }).data.every(t => t.accountId === "acc_savings")).toBe(true)
    expect(listTransactions({ min: 100000 }).data.every(t => Math.abs(t.amount) >= 100000)).toBe(true)
  })
})

describe("getTransaction", () => {
  it("returns the planted charge and undefined for missing", () => {
    const dd = getTransaction("txn_doordash_87")
    expect(dd?.amount).toBe(-8700)
    expect(getTransaction("nope")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement repositories**

`src/server/transactions.ts`:
```ts
import { getStore } from "./store"
import type { Transaction, Category, TxStatus } from "./types"

export interface TxQuery {
  search?: string; category?: Category; accountId?: string; cardId?: string
  status?: TxStatus; from?: string; to?: string; min?: number; max?: number
  sort?: "newest" | "oldest" | "amount"; limit?: number; cursor?: string
}
export interface Page<T> { data: T[]; nextCursor?: string; total: number }

export function listTransactions(q: TxQuery = {}): Page<Transaction> {
  let rows = getStore().transactions.slice()
  if (q.search) {
    const s = q.search.toLowerCase()
    rows = rows.filter(t => t.merchant.toLowerCase().includes(s) || t.descriptor.toLowerCase().includes(s))
  }
  if (q.category) rows = rows.filter(t => t.category === q.category)
  if (q.accountId) rows = rows.filter(t => t.accountId === q.accountId)
  if (q.cardId) rows = rows.filter(t => t.cardId === q.cardId)
  if (q.status) rows = rows.filter(t => t.status === q.status)
  if (q.from) rows = rows.filter(t => +new Date(t.timestamp) >= +new Date(q.from!))
  if (q.to) rows = rows.filter(t => +new Date(t.timestamp) <= +new Date(q.to!))
  if (q.min != null) rows = rows.filter(t => Math.abs(t.amount) >= q.min!)
  if (q.max != null) rows = rows.filter(t => Math.abs(t.amount) <= q.max!)

  if (q.sort === "oldest") rows.sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))
  else if (q.sort === "amount") rows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  else rows.sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))

  const total = rows.length
  const limit = q.limit ?? 25
  const start = q.cursor ? Math.max(0, rows.findIndex(t => t.id === q.cursor)) : 0
  const slice = rows.slice(start, start + limit)
  const next = rows[start + limit]
  return { data: slice, nextCursor: next?.id, total }
}

export function getTransaction(id: string): Transaction | undefined {
  return getStore().transactions.find(t => t.id === id)
}
```

`src/server/accounts.ts`:
```ts
import { getStore } from "./store"
import type { Account, Profile } from "./types"
import { listTransactions } from "./transactions"

export function listAccounts(): Account[] { return getStore().accounts }
export function getAccount(id: string): Account | undefined {
  return getStore().accounts.find(a => a.id === id)
}
export function getAccountTransactions(id: string, limit = 50) {
  return listTransactions({ accountId: id, limit })
}
export function getProfile(): Profile {
  const accts = getStore().accounts
  const netWorth = accts.reduce((s, a) => s + a.balance, 0)
  return { name: "Yousef Helal", email: "yousef@maple.com", netWorth,
    accountCount: accts.length, avatarInitials: "YH" }
}
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**
```bash
git add src/server/transactions.ts src/server/accounts.ts src/server/__tests__/transactions.test.ts
git commit -m "feat: transaction + account repositories with filtering and pagination"
```

---

## Task 6: Derived repositories — insights, cards, payments, notifications (TDD)

**Files:**
- Create: `apps/demo-bank/src/server/insights.ts`, `cards.ts`, `payments.ts`, `notifications.ts`
- Test: `apps/demo-bank/src/server/__tests__/insights.test.ts`

- [ ] **Step 1: Write the failing test**

`src/server/__tests__/insights.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest"
import { __reseed } from "../store"
import { spendingByCategory, budgets, cashflow, recurring } from "../insights"

beforeAll(() => __reseed(new Date("2026-06-29T12:00:00-07:00")))

describe("insights", () => {
  it("spending-by-category reconciles with this month's debits", () => {
    const slices = spendingByCategory()
    expect(slices.length).toBeGreaterThan(0)
    expect(slices.every(s => s.amount >= 0)).toBe(true)
    // dining must include the $87 DoorDash this month
    const dining = slices.find(s => s.category === "dining")
    expect(dining && dining.amount >= 8700).toBe(true)
  })
  it("budgets never report negative spent and have a positive limit", () => {
    for (const b of budgets()) { expect(b.spent).toBeGreaterThanOrEqual(0); expect(b.limit).toBeGreaterThan(0) }
  })
  it("cashflow returns in/out points", () => {
    const c = cashflow()
    expect(c.length).toBeGreaterThan(0)
    expect(c.every(p => p.in >= 0 && p.out >= 0)).toBe(true)
  })
  it("detects recurring subscriptions", () => {
    expect(recurring().some(r => r.merchant === "Spotify")).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify fail** — FAIL.

- [ ] **Step 3: Implement derived repositories**

`src/server/insights.ts`:
```ts
import { getStore } from "./store"
import type { SpendingSlice, Budget, CashflowPoint, Recurring, Category, Transaction } from "./types"

function thisMonth(t: Transaction, now = new Date()) {
  const d = new Date(t.timestamp)
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
}
function monthAnchor() {
  // Use the most recent transaction as "now" so it tracks the seeded anchor.
  const txns = getStore().transactions
  return txns.length ? new Date(txns[0].timestamp) : new Date()
}

export function spendingByCategory(): SpendingSlice[] {
  const now = monthAnchor()
  const sums = new Map<Category, number>()
  for (const t of getStore().transactions) {
    if (t.amount >= 0) continue
    if (!thisMonth(t, now)) continue
    if (t.category === "transfer") continue
    sums.set(t.category, (sums.get(t.category) ?? 0) + Math.abs(t.amount))
  }
  return [...sums.entries()].map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount)
}

const BUDGET_LIMITS: Partial<Record<Category, number>> = {
  dining: 60000, groceries: 50000, coffee: 12000, transport: 30000,
  shopping: 60000, subscriptions: 12000,
}
export function budgets(): Budget[] {
  const spend = new Map(spendingByCategory().map(s => [s.category, s.amount]))
  return Object.entries(BUDGET_LIMITS).map(([category, limit]) => ({
    category: category as Category, limit: limit!, spent: spend.get(category as Category) ?? 0,
  }))
}

export function cashflow(): CashflowPoint[] {
  const byMonth = new Map<string, { in: number; out: number }>()
  for (const t of getStore().transactions) {
    if (t.category === "transfer") continue
    const d = new Date(t.timestamp)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    const cur = byMonth.get(key) ?? { in: 0, out: 0 }
    if (t.amount >= 0) cur.in += t.amount; else cur.out += Math.abs(t.amount)
    byMonth.set(key, cur)
  }
  return [...byMonth.entries()].sort().map(([label, v]) => ({ label, ...v }))
}

export function recurring(): Recurring[] {
  const seen = new Map<string, Recurring>()
  for (const t of getStore().transactions) {
    if (!t.recurringId || t.amount >= 0) continue
    if (!seen.has(t.recurringId)) {
      const next = new Date(t.timestamp); next.setMonth(next.getMonth() + 1)
      seen.set(t.recurringId, { id: t.recurringId, merchant: t.merchant, amount: t.amount,
        cadence: "monthly", category: t.category, nextDate: next.toISOString() })
    }
  }
  return [...seen.values()].sort((a, b) => a.amount - b.amount)
}
```

`src/server/cards.ts`:
```ts
import { getStore } from "./store"
import { listTransactions } from "./transactions"
import type { Card } from "./types"

export function listCards(): Card[] { return getStore().cards }
export function getCard(id: string): Card | undefined { return getStore().cards.find(c => c.id === id) }
export function getCardTransactions(id: string, limit = 25) {
  return listTransactions({ cardId: id, limit })
}
```

`src/server/payments.ts`:
```ts
import { getStore } from "./store"
import type { Payee, ScheduledPayment, Goal } from "./types"

export function listPayees(): Payee[] { return getStore().payees }
export function listScheduled(): ScheduledPayment[] { return getStore().scheduled }
export function listGoals(): Goal[] { return getStore().goals }
```

`src/server/notifications.ts`:
```ts
import { getStore } from "./store"
import type { Notification } from "./types"

export function listNotifications(): Notification[] {
  return [...getStore().notifications].sort((a, b) => +new Date(b.at) - +new Date(a.at))
}
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**
```bash
git add src/server/insights.ts src/server/cards.ts src/server/payments.ts src/server/notifications.ts src/server/__tests__/insights.test.ts
git commit -m "feat: insights, cards, payments, notifications repositories"
```

---

## Task 7: API route handlers (TDD)

**Files:**
- Create: all files under `apps/demo-bank/src/app/api/**/route.ts`, plus `src/server/http.ts` (envelope helpers)
- Test: `apps/demo-bank/src/server/__tests__/api.test.ts` (imports route handlers directly and asserts Response)

Route handlers are thin: parse params/query → call repository → wrap in envelope. Test by importing the handler functions and calling them with a `Request`.

- [ ] **Step 1: Write envelope helpers**

`src/server/http.ts`:
```ts
import { NextResponse } from "next/server"

export function ok<T>(data: T) { return NextResponse.json({ data }) }
export function notFound(message = "Not found") {
  return NextResponse.json({ error: { message, code: "not_found" } }, { status: 404 })
}
export function badRequest(message: string) {
  return NextResponse.json({ error: { message, code: "bad_request" } }, { status: 400 })
}
```

- [ ] **Step 2: Write the failing API test**

`src/server/__tests__/api.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest"
import { __reseed } from "../store"
import { GET as getTxns } from "@/app/api/transactions/route"
import { GET as getTxn } from "@/app/api/transactions/[id]/route"
import { GET as getAccounts } from "@/app/api/accounts/route"

beforeAll(() => __reseed(new Date("2026-06-29T12:00:00-07:00")))

describe("api", () => {
  it("GET /api/transactions returns an enveloped page", async () => {
    const res = await getTxns(new Request("http://x/api/transactions?limit=5"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.length).toBe(5)
  })
  it("GET /api/transactions/:id returns the DoorDash charge", async () => {
    const res = await getTxn(new Request("http://x"), { params: Promise.resolve({ id: "txn_doordash_87" }) })
    const body = await res.json()
    expect(body.data.amount).toBe(-8700)
  })
  it("GET /api/transactions/:id 404s for missing id", async () => {
    const res = await getTxn(new Request("http://x"), { params: Promise.resolve({ id: "nope" }) })
    expect(res.status).toBe(404)
  })
  it("GET /api/accounts returns four accounts", async () => {
    const res = await getAccounts()
    const body = await res.json()
    expect(body.data.length).toBe(4)
  })
})
```

- [ ] **Step 3: Run to verify fail** — FAIL (routes missing).

- [ ] **Step 4: Implement all route handlers**

Representative handlers (implement the rest following the same pattern — one repository call each):

`src/app/api/transactions/route.ts`:
```ts
import { listTransactions, type TxQuery } from "@/server/transactions"
import { ok } from "@/server/http"
import type { Category, TxStatus } from "@/server/types"

export async function GET(req: Request) {
  const u = new URL(req.url)
  const num = (k: string) => { const v = u.searchParams.get(k); return v == null ? undefined : Number(v) }
  const q: TxQuery = {
    search: u.searchParams.get("search") ?? undefined,
    category: (u.searchParams.get("category") as Category) ?? undefined,
    accountId: u.searchParams.get("accountId") ?? undefined,
    status: (u.searchParams.get("status") as TxStatus) ?? undefined,
    from: u.searchParams.get("from") ?? undefined,
    to: u.searchParams.get("to") ?? undefined,
    min: num("min"), max: num("max"),
    sort: (u.searchParams.get("sort") as TxQuery["sort"]) ?? undefined,
    limit: num("limit"), cursor: u.searchParams.get("cursor") ?? undefined,
  }
  return ok(listTransactions(q))
}
```

`src/app/api/transactions/[id]/route.ts`:
```ts
import { getTransaction } from "@/server/transactions"
import { ok, notFound } from "@/server/http"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = getTransaction(id)
  return t ? ok(t) : notFound("Transaction not found")
}
```

Remaining route files (each one repository call):
- `accounts/route.ts` → `listAccounts()`
- `accounts/[id]/route.ts` → `getAccount(id)` or 404
- `accounts/[id]/transactions/route.ts` → `getAccountTransactions(id)`
- `profile/route.ts` → `getProfile()`
- `cards/route.ts` → `listCards()`; `cards/[id]/transactions/route.ts` → `getCardTransactions(id)`
- `insights/spending/route.ts` → `spendingByCategory()`; `insights/cashflow` → `cashflow()`;
  `insights/budgets` → `budgets()`; `insights/recurring` → `recurring()`
- `payees/route.ts` → `listPayees()`; `payments/scheduled/route.ts` → `listScheduled()`;
  `goals/route.ts` → `listGoals()`; `notifications/route.ts` → `listNotifications()`

- [ ] **Step 5: Run to verify pass** — `npx vitest run src/server/__tests__/api.test.ts` → PASS.

- [ ] **Step 6: Manual API smoke**

Run `npm run dev`, then:
```bash
curl -s localhost:3000/api/transactions/txn_doordash_87 | python3 -m json.tool
curl -s "localhost:3000/api/transactions?search=doordash&limit=3" | python3 -m json.tool
curl -s localhost:3000/api/insights/spending | python3 -m json.tool
```
Expected: DoorDash charge shows `-8700`; spending lists dining ≥ 8700.

- [ ] **Step 7: Commit**
```bash
git add src/app/api src/server/http.ts src/server/__tests__/api.test.ts
git commit -m "feat: REST API route handlers over repositories"
```

---

## Task 8: Typed API client + SWR hooks

**Files:**
- Create: `apps/demo-bank/src/lib/api-client.ts`, `apps/demo-bank/src/lib/hooks.ts`, `apps/demo-bank/src/lib/format.ts`, `apps/demo-bank/src/lib/cn.ts`

- [ ] **Step 1: Implement `cn` and date format helpers**

`src/lib/cn.ts`:
```ts
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
export function cn(...a: ClassValue[]) { return twMerge(clsx(a)) }
```

`src/lib/format.ts`:
```ts
export function formatDate(iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  return new Date(iso).toLocaleDateString("en-US", opts)
}
export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}
export function relativeDay(iso: string, now = new Date()) {
  const d = new Date(iso); const days = Math.floor((+startOfDay(now) - +startOfDay(d)) / 86400000)
  if (days === 0) return "Today"; if (days === 1) return "Yesterday"
  return formatDate(iso, { weekday: "short", month: "short", day: "numeric" })
}
function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
```

- [ ] **Step 2: Implement the fetch client**

`src/lib/api-client.ts`:
```ts
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const body = await res.json()
  if (!res.ok) throw new Error(body?.error?.message ?? "Request failed")
  return body.data as T
}
export const api = { get }
```

- [ ] **Step 3: Implement SWR hooks**

`src/lib/hooks.ts`:
```ts
"use client"
import useSWR from "swr"
import { api } from "./api-client"
import type {
  Account, Transaction, Card, Profile, SpendingSlice, Budget, CashflowPoint,
  Recurring, Payee, ScheduledPayment, Goal, Notification,
} from "@/server/types"
import type { Page } from "@/server/transactions"

const f = <T,>(url: string) => api.get<T>(url)

export const useProfile = () => useSWR<Profile>("/api/profile", f)
export const useAccounts = () => useSWR<Account[]>("/api/accounts", f)
export const useAccount = (id: string) => useSWR<Account>(`/api/accounts/${id}`, f)
export const useTransactions = (qs = "") => useSWR<Page<Transaction>>(`/api/transactions${qs}`, f)
export const useTransaction = (id: string) => useSWR<Transaction>(`/api/transactions/${id}`, f)
export const useCards = () => useSWR<Card[]>("/api/cards", f)
export const useSpending = () => useSWR<SpendingSlice[]>("/api/insights/spending", f)
export const useBudgets = () => useSWR<Budget[]>("/api/insights/budgets", f)
export const useCashflow = () => useSWR<CashflowPoint[]>("/api/insights/cashflow", f)
export const useRecurring = () => useSWR<Recurring[]>("/api/insights/recurring", f)
export const usePayees = () => useSWR<Payee[]>("/api/payees", f)
export const useScheduled = () => useSWR<ScheduledPayment[]>("/api/payments/scheduled", f)
export const useGoals = () => useSWR<Goal[]>("/api/goals", f)
export const useNotifications = () => useSWR<Notification[]>("/api/notifications", f)
```
(Export `Page` type from `transactions.ts`.)

- [ ] **Step 4: Typecheck**

Run: `cd apps/demo-bank && npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 5: Commit**
```bash
git add src/lib && git commit -m "feat: typed API client, SWR hooks, format helpers"
```

---

## Task 9: Design tokens + UI primitives

**Files:**
- Modify: `apps/demo-bank/src/app/globals.css`, `apps/demo-bank/src/app/layout.tsx`
- Create: `src/components/ui/{button,card,badge,skeleton,segmented,tabs,sheet,dropdown,tooltip,switch,toast}.tsx`

- [ ] **Step 1: Design tokens + base styles**

Replace `globals.css` with token layer: CSS variables for `--ink:#111`, `--bg:#FBFBFA`, `--surface:#fff`, `--border:#ECEBE8`, `--muted:#9A9690`, `--pos:#1E7F53`, `--neg:#B0473A`, radii, shadows. Set `body { background:var(--bg); color:var(--ink); }`, enable `font-feature-settings:"tnum"` utility class `.tnum`. Load **Inter** via `next/font` in `layout.tsx` and apply to `<html>`.

`src/app/layout.tsx`:
```tsx
import type { Metadata } from "next"
import { Inter } from "next/font/google"
import "./globals.css"
import { AppShell } from "@/components/shell/app-shell"

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" })
export const metadata: Metadata = { title: "Maple", description: "Banking that keeps up." }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body><AppShell>{children}</AppShell></body>
    </html>
  )
}
```

- [ ] **Step 2: Build primitives**

Each is a small, styled component using `cn`. Required props/variants:
- `Button` — variants `primary | secondary | ghost | danger`, sizes `sm | md`; focus ring; 150ms transition.
- `Card` — surface, 1px border, radius 14, optional `hover` lift.
- `Badge` — neutral/positive/negative/category tones.
- `Skeleton` — shimmering block; `SkeletonText`, `SkeletonCard` helpers.
- `Segmented` — controlled segmented control (used for chart range, tx filters).
- `Tabs`, `Sheet`(Radix Dialog as right sheet + modal), `Dropdown`(Radix), `Tooltip`(Radix), `Switch`(Radix), `Toast` (lightweight context + `useToast`).

Build to the look spec: monochrome, hairline borders, hover/active/focus states.

- [ ] **Step 3: Verify primitives render**

Temporarily render each primitive on `/` (or a scratch route), `npm run dev`, screenshot, confirm styling. Remove scratch usage after.

- [ ] **Step 4: Commit**
```bash
git add src/app/globals.css src/app/layout.tsx src/components/ui
git commit -m "feat: design tokens, Inter, and UI primitive library"
```

---

## Task 10: App shell — sidebar, topbar, command palette, notifications

**Files:**
- Create: `src/components/shell/{app-shell,sidebar,topbar,command-palette,notifications-menu,account-switcher}.tsx`

- [ ] **Step 1: Sidebar**

`sidebar.tsx`: brand (rounded-square "M" + "Maple"), primary nav (Home `/`, Accounts `/accounts`, Transactions `/transactions`, Cards `/cards`, Payments `/payments`, Insights `/insights`), secondary (Activity `/activity`, Settings `/settings`), each with a Lucide icon and active state via `usePathname()`. Profile footer with avatar initials (from `useProfile`) + account switcher dropdown.

- [ ] **Step 2: Topbar**

`topbar.tsx`: page title (from a small route→title map), global search input that opens the command palette on focus/⌘K, quick actions (Send, Request, Move money) as `Button`s, notifications bell with unread dot (count from `useNotifications`) opening `notifications-menu`.

- [ ] **Step 3: Command palette**

`command-palette.tsx`: `cmdk` dialog, ⌘K / Ctrl-K to open, lists nav destinations and recent transactions (from `useTransactions("?limit=8")`); selecting a transaction routes to its detail. Mounted once in `app-shell`.

- [ ] **Step 4: Assemble shell**

`app-shell.tsx`: grid with fixed sidebar + main column (topbar + `{children}`). Wrap children in the `Toast` provider and command-palette provider. Responsive: sidebar collapses under ~1024px (icon-only or off-canvas).

- [ ] **Step 5: Verify**

`npm run dev`, screenshot every route shell (nav highlights correct item, ⌘K opens palette, bell shows unread dot). 

- [ ] **Step 6: Commit**
```bash
git add src/components/shell && git commit -m "feat: app shell with sidebar, topbar, command palette, notifications"
```

---

## Task 11: Chart components

**Files:**
- Create: `src/components/charts/{area-trend,donut,bars,sparkline,cashflow-bars}.tsx`

- [ ] **Step 1: Build charts**

- `AreaTrend` — Recharts area/line, monochrome stroke, soft fill, no axes chrome beyond minimal; animated draw-on-mount; accepts `number[]` or `{x,y}[]`.
- `Donut` — Recharts pie/donut for spending slices; category color scale (muted, restrained); center label = total.
- `Bars` — horizontal ranked bars for category spend / budgets with over-limit tint.
- `Sparkline` — tiny hand-rolled SVG polyline for account cards (no lib).
- `CashflowBars` — paired in/out bars per month.

Use one shared muted category color map in `src/components/charts/colors.ts`.

- [ ] **Step 2: Verify** — render each with seed data on a scratch route, screenshot, confirm restraint + legibility. Remove scratch usage.

- [ ] **Step 3: Commit**
```bash
git add src/components/charts && git commit -m "feat: restrained chart components (area, donut, bars, sparkline)"
```

---

## Task 12: Home page

**Files:**
- Create: `src/app/page.tsx`, `src/components/home/{net-worth-card,quick-actions,accounts-strip,cashflow-card,recent-activity,upcoming-bills,spending-mini,goals-card}.tsx`
- Create: `src/components/transactions/transaction-row.tsx` (shared, reused on Transactions page)

- [ ] **Step 1: Build `TransactionRow`**

Shared row: merchant avatar (initials in a rounded square, tinted by category), merchant name + relative day/time, category icon, `formatAmount(amount)` right-aligned with `tnum` and pos/neg color, hover background, links to `/transactions/[id]`. Pending/authorized get a small badge.

- [ ] **Step 2: Build Home widgets**

Each widget is a `"use client"` component using its hook with a `Skeleton` while loading:
- `NetWorthCard` — `useProfile()` net worth + MoM delta badge + `AreaTrend` (range `Segmented`: 1W/1M/3M/1Y/All driving the series; derive series from accounts sparkline or a `/api/insights/cashflow`-style trend — use checking sparkline for now).
- `QuickActions` — Send / Request / Move money / Pay bill / Deposit buttons (open a toast "coming soon" or route to `/payments`).
- `AccountsStrip` — `useAccounts()` cards with `Sparkline` + balance.
- `CashflowCard` — `useCashflow()` latest month in vs out.
- `RecentActivity` — `useTransactions("?limit=8")` list of `TransactionRow`; DoorDash 1:14 AM appears on top.
- `UpcomingBills` — `useScheduled()`.
- `SpendingMini` — `useSpending()` small `Donut`.
- `GoalsCard` — `useGoals()` progress bars.

- [ ] **Step 3: Compose `page.tsx`**

Responsive grid: net worth (wide) + accounts strip on top row; recent activity (2/3) beside a right column of cashflow / spending mini / upcoming bills / goals.

- [ ] **Step 4: Verify**

`npm run dev` → `/`. Screenshot. Confirm: all data loads from `/api/*` (check Network tab), skeletons appear then content, DoorDash $87 1:14 AM on top of recent activity, no empty-looking regions.

- [ ] **Step 5: Commit**
```bash
git add src/app/page.tsx src/components/home src/components/transactions/transaction-row.tsx
git commit -m "feat: Home dashboard with live widgets"
```

---

## Task 13: Transactions list + detail

**Files:**
- Create: `src/app/transactions/page.tsx`, `src/app/transactions/[id]/page.tsx`
- Create: `src/components/transactions/{filters-bar,tx-list,tx-detail,status-timeline,static-map}.tsx`

- [ ] **Step 1: Transactions list**

`page.tsx` (client): `FiltersBar` (search input, category dropdown, account dropdown, status, amount range, sort `Segmented`) building a query string; `useTransactions(qs)`; date-grouped list of `TransactionRow`; summary header (`total` count + summed amount for filter); "Load more" using `nextCursor`; CSV export button (builds a client-side CSV from loaded rows). Skeleton list while loading; designed empty state when no matches.

- [ ] **Step 2: Transaction detail**

`[id]/page.tsx` (client): `useTransaction(id)`; hero amount (`formatAmount`, large, `tnum`), merchant + avatar, descriptor, exact date + time (`formatDate` + `formatTime` → shows "1:14 AM"), category badge (with edit affordance opening a dropdown — optimistic only), account + method, `StatusTimeline` (authorized → posted from `statusTimeline`), `StaticMap` (simple SVG/box with location label), notes, actions row (Report a problem / Split / Download — toast). Handle 404 with a designed not-found state.

- [ ] **Step 3: Verify**

Screenshot `/transactions` (filters work, grouping, load-more) and `/transactions/txn_doordash_87` (shows −$87.00, 1:14 AM, timeline, map). Confirm `/transactions/nope` shows the not-found state.

- [ ] **Step 4: Commit**
```bash
git add src/app/transactions src/components/transactions
git commit -m "feat: transactions list with filters and rich transaction detail"
```

---

## Task 14: Accounts list + detail

**Files:**
- Create: `src/app/accounts/page.tsx`, `src/app/accounts/[id]/page.tsx`
- Create: `src/components/accounts/{account-card,account-header,number-reveal,statements-list}.tsx`

- [ ] **Step 1: Accounts overview** — `useAccounts()` grid of `AccountCard` (name, type, mask, balance, APY for savings, `Sparkline`), links to detail.
- [ ] **Step 2: Account detail** — `useAccount(id)` header (large balance, `NumberReveal` for account/routing with copy-to-clipboard + toast, APY), `AreaTrend` from sparkline, this account's transactions via `useTransactions("?accountId=" + id)`, `StatementsList` (static PDF-style rows, download → toast). 404 state for bad id.
- [ ] **Step 3: Verify** — screenshot overview + a detail (reveal toggles, copy works).
- [ ] **Step 4: Commit**
```bash
git add src/app/accounts src/components/accounts
git commit -m "feat: accounts overview and account detail"
```

---

## Task 15: Cards page

**Files:**
- Create: `src/app/cards/page.tsx`, `src/components/cards/{card-visual,card-controls,card-carousel}.tsx`

- [ ] **Step 1: Card visual** — realistic card face (gradient per `design`, Maple wordmark, network mark, `•••• mask`, exp), `frozen` overlay state.
- [ ] **Step 2: Controls + carousel** — `useCards()`; carousel/selector; per card: freeze `Switch` (optimistic + toast), spend-limit `Segmented`/slider (presentational), reveal masked number (copy + toast), "Add to Apple Wallet" button (toast), recent card transactions via `useTransactions("?cardId=" + id)`.
- [ ] **Step 3: Verify** — screenshot; freeze toggles visual; reveal/copy works.
- [ ] **Step 4: Commit**
```bash
git add src/app/cards src/components/cards
git commit -m "feat: cards page with realistic card visuals and controls"
```

---

## Task 16: Insights page

**Files:**
- Create: `src/app/insights/page.tsx`, `src/components/insights/{spending-card,budgets-card,recurring-card,top-merchants,cashflow-card-lg}.tsx`

- [ ] **Step 1: Build widgets** — `useSpending()` donut + ranked `Bars`; `useBudgets()` progress bars with over/under tint; `useRecurring()` subscription list with next-charge date + monthly total; `TopMerchants` (derive from `useTransactions("?limit=200")` by summing per merchant client-side); `useCashflow()` `CashflowBars` with MoM summary.
- [ ] **Step 2: Compose** responsive grid; month label header.
- [ ] **Step 3: Verify** — screenshot; confirm dining reflects the $87 and totals look sane.
- [ ] **Step 4: Commit**
```bash
git add src/app/insights src/components/insights
git commit -m "feat: insights page (spending, budgets, recurring, cashflow)"
```

---

## Task 17: Payments, Activity, Settings

**Files:**
- Create: `src/app/payments/page.tsx`, `src/app/activity/page.tsx`, `src/app/settings/page.tsx`
- Create: `src/components/payments/{move-money-tabs,payees-list,scheduled-list}.tsx`, `src/components/activity/activity-feed.tsx`

- [ ] **Step 1: Payments** — `Tabs` (Send / Request / Transfer / Pay bills); `usePayees()` list; `useScheduled()` upcoming & recurring; presentational forms (amount input, payee select, "Review" button → toast "Demo only"). No real writes.
- [ ] **Step 2: Activity** — `useNotifications()` chronological feed grouped by day, icon per kind, unread styling; mark-all-read (optimistic).
- [ ] **Step 3: Settings** — profile (from `useProfile`), security toggles (`Switch`), linked accounts, preferences. Presentational.
- [ ] **Step 4: Verify** — screenshot all three; confirm no empty pages.
- [ ] **Step 5: Commit**
```bash
git add src/app/payments src/app/activity src/app/settings src/components/payments src/components/activity
git commit -m "feat: payments, activity, and settings pages"
```

---

## Task 18: Loading/empty states, motion, responsive pass

**Files:**
- Create: `src/app/loading.tsx`, `src/app/not-found.tsx`, route-level `loading.tsx` where helpful
- Modify: widgets to add Framer Motion mount transitions; shell for responsive

- [ ] **Step 1: Global loading + not-found** — app-level skeleton `loading.tsx` and a branded `not-found.tsx`.
- [ ] **Step 2: Motion** — wrap balance numbers with a count-up, charts draw-on-mount, sheet/menu transitions; gate on `prefers-reduced-motion`.
- [ ] **Step 3: Responsive** — verify 1024–1440px: sidebar collapse, grids reflow, no overflow.
- [ ] **Step 4: Verify** — screenshot at 1280px and 1024px.
- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "polish: loading/empty states, motion, responsive pass"
```

---

## Task 19: Final verification + README

**Files:**
- Modify: root `README.md`, `apps/demo-bank/README.md`

- [ ] **Step 1: Full test + build**

Run:
```bash
cd apps/demo-bank && npx vitest run && npx tsc --noEmit && npm run build
```
Expected: all tests pass, no type errors, production build succeeds.

- [ ] **Step 2: End-to-end manual walkthrough**

`npm run dev`; visit every route; confirm: data from `/api/*` (Network tab), skeleton→content, ⌘K, notifications, DoorDash $87 / 1:14 AM on Home and detail, no empty/broken regions. Screenshot Home, Transactions, Transaction detail, Cards, Insights.

- [ ] **Step 3: READMEs**

Root README: monorepo layout + how to run. `apps/demo-bank/README.md`: what Maple is (demo host for the Flowlet "$87 Mystery" demo), stack, `npm run dev`, API endpoint list, where the planted charge lives, note that writes/integrations are out of scope.

- [ ] **Step 4: Commit**
```bash
git add -A && git commit -m "docs: READMEs and final verification"
```

---

## Self-Review Notes (coverage check)

- Spec pages → Tasks 12–17 (Home, Transactions, Accounts, Cards, Payments, Insights, Activity, Settings). ✓
- Spec endpoints (17) → Task 7 (representative + enumerated rest). ✓
- Real server/API + UI-over-HTTP → Tasks 4–8 (store→repos→routes→client/SWR), no direct seed imports in UI. ✓
- Planted $87 / 1:14 AM DoorDash → Task 4 seed + asserted in Tasks 4,5,7; surfaced in 12,13. ✓
- Polish bar (Inter, tnum, skeletons, motion, ⌘K, toasts, empty/404) → Tasks 9,10,18. ✓
- Deterministic seed, integer cents, envelope/status codes → Tasks 2–7. ✓
- Out of scope (writes, Gmail, Flowlet) → not implemented; payments/cards controls are presentational. ✓
