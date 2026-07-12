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

// Recurring merchant templates
const RECURRING: { merchant: string; category: Category; dom: number; cents: number; descriptor: string }[] = [
  { merchant: "Equinox", category: "subscriptions", dom: 1, cents: -28500, descriptor: "EQUINOX SF" },
  { merchant: "Rent — Mission St", category: "housing", dom: 1, cents: -285000, descriptor: "ACH RENT MISSION" },
  { merchant: "Spotify", category: "subscriptions", dom: 4, cents: -1199, descriptor: "SPOTIFY USA" },
  { merchant: "Netflix", category: "subscriptions", dom: 7, cents: -1549, descriptor: "NETFLIX.COM" },
  { merchant: "iCloud+", category: "subscriptions", dom: 9, cents: -299, descriptor: "APPLE.COM/BILL" },
  { merchant: "ChatGPT", category: "subscriptions", dom: 12, cents: -2000, descriptor: "OPENAI CHATGPT" },
]

// One-off merchant pool
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
    if (day % 14 === 0) {
      add({ accountId: CHECKING, merchant: "Acme Corp Payroll", descriptor: "ACME CORP DIR DEP",
        amount: 642000, timestamp: iso(daysAgo(anchor, day, 9, 2)), category: "income", status: "posted",
        method: "ACH deposit" })
      add({ accountId: CHECKING, merchant: "Transfer to Savings", descriptor: "INTERNAL XFER",
        amount: -100000, timestamp: iso(daysAgo(anchor, day, 9, 5)), category: "transfer", status: "posted",
        method: "Internal transfer" })
      add({ accountId: SAVINGS, merchant: "Transfer from Checking", descriptor: "INTERNAL XFER",
        amount: 100000, timestamp: iso(daysAgo(anchor, day, 9, 5)), category: "transfer", status: "posted",
        method: "Internal transfer" })
    }
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

  add({ accountId: CHECKING, merchant: "Amazon", descriptor: "AMZN Refund", amount: 3499,
    timestamp: iso(daysAgo(anchor, 7, 14, 22)), category: "shopping", status: "posted" })

  add({ accountId: CHECKING, merchant: "Whole Foods Market", descriptor: "WHOLEFDS SFO", amount: -5218,
    timestamp: iso(daysAgo(anchor, 1, 18, 40)), category: "groceries", status: "posted" })
  add({ accountId: CREDIT, merchant: "United Airlines", descriptor: "UNITED 016", amount: -41800,
    timestamp: iso(daysAgo(anchor, 1, 11, 5)), category: "transport", status: "authorized", cardId: "card_virtual" })

  // Late-night spending — a believable after-hours pattern across the quarter
  // (food delivery, rides home, 2 AM impulse buys). This is the substance behind
  // "what did I spend when I should've been asleep?"; the planted $87 DoorDash
  // below is simply the most recent of these.
  const LATE_NIGHT: {
    d: number; h: number; m: number; merchant: string; descriptor: string;
    cents: number; category: Category; account: string; card: string;
  }[] = [
    { d: 4,  h: 0,  m: 42, merchant: "Uber Eats",  descriptor: "UBER EATS SF",        cents: -3460, category: "dining",    account: CHECKING, card: "card_physical" },
    { d: 4,  h: 2,  m: 18, merchant: "Lyft",       descriptor: "LYFT *RIDE",          cents: -2340, category: "transport", account: CHECKING, card: "card_physical" },
    { d: 9,  h: 2,  m: 33, merchant: "Amazon",     descriptor: "AMZN MKTP US",        cents: -6499, category: "shopping",  account: CREDIT,   card: "card_virtual" },
    { d: 12, h: 1,  m: 50, merchant: "Taco Bell",  descriptor: "TACO BELL 7042",      cents: -1820, category: "dining",    account: CHECKING, card: "card_physical" },
    { d: 18, h: 23, m: 52, merchant: "DoorDash",   descriptor: "DOORDASH*ORDER 5521", cents: -4130, category: "dining",    account: CHECKING, card: "card_physical" },
    { d: 22, h: 1,  m: 5,  merchant: "Uber",       descriptor: "UBER *TRIP",          cents: -2975, category: "transport", account: CHECKING, card: "card_physical" },
    { d: 26, h: 0,  m: 28, merchant: "Steam",      descriptor: "STEAMGAMES.COM",      cents: -5999, category: "shopping",  account: CREDIT,   card: "card_virtual" },
    { d: 33, h: 1,  m: 37, merchant: "Uber Eats",  descriptor: "UBER EATS SF",        cents: -2780, category: "dining",    account: CHECKING, card: "card_physical" },
    { d: 41, h: 2,  m: 9,  merchant: "7-Eleven",   descriptor: "7-ELEVEN 33418",      cents: -1240, category: "groceries", account: CHECKING, card: "card_physical" },
    { d: 48, h: 0,  m: 15, merchant: "McDonald's", descriptor: "MCDONALDS F2241",     cents: -1485, category: "dining",    account: CHECKING, card: "card_physical" },
    { d: 57, h: 1,  m: 22, merchant: "Amazon",     descriptor: "AMZN MKTP US",        cents: -3850, category: "shopping",  account: CREDIT,   card: "card_virtual" },
  ]
  for (const x of LATE_NIGHT) {
    add({ accountId: x.account, cardId: x.card, merchant: x.merchant, descriptor: x.descriptor,
      amount: x.cents, timestamp: iso(daysAgo(anchor, x.d, x.h, x.m)), category: x.category,
      status: "posted", location: "San Francisco, CA" })
  }

  // THE PLANTED CHARGE — most recent, 1:14 AM today, $87.00, DoorDash, checking
  const dd = new Date(anchor); dd.setHours(1, 14, 0, 0)
  add({ id: "txn_doordash_87", accountId: CHECKING, cardId: "card_physical",
    merchant: "DoorDash", descriptor: "DOORDASH*ORDER 8742 CA", amount: -8700,
    timestamp: iso(dd), category: "dining", status: "posted", location: "San Francisco, CA",
    method: "Maple Debit ·· 4471" })

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
    { id: "goal_japan", name: "Japan trip", target: 500000, saved: 312000, icon: "plane" },
    { id: "goal_emergency", name: "Emergency fund", target: 1000000, saved: 740000, icon: "shield" },
    { id: "goal_mac", name: "New MacBook", target: 250000, saved: 90000, icon: "laptop" },
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
