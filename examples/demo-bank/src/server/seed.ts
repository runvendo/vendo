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
const JOINT = "acc_savings_joint"
const CREDIT = "acc_credit"
const INVEST = "acc_investing"
const BUSINESS = "acc_business"
const MONEYMARKET = "acc_moneymarket"

/** Six months of history, in days. */
const HISTORY_DAYS = 180

function iso(d: Date) { return d.toISOString() }
function daysAgo(anchor: Date, n: number, h = 12, m = 0) {
  const d = new Date(anchor); d.setDate(d.getDate() - n); d.setHours(h, m, 0, 0); return d
}
function initials(name: string) {
  return name.replace(/[^a-zA-Z ]/g, "").split(" ").filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase()
}

// Recurring merchant templates — rent, utilities and ten subscriptions,
// each on its own day of month so the recurring detector has real signal.
const RECURRING: { merchant: string; category: Category; dom: number; cents: number; descriptor: string }[] = [
  { merchant: "Rent — Mission St", category: "housing", dom: 1, cents: -285000, descriptor: "ACH RENT MISSION" },
  { merchant: "Equinox", category: "subscriptions", dom: 1, cents: -28500, descriptor: "EQUINOX SF" },
  { merchant: "Spotify", category: "subscriptions", dom: 4, cents: -1199, descriptor: "SPOTIFY USA" },
  { merchant: "Netflix", category: "subscriptions", dom: 7, cents: -1549, descriptor: "NETFLIX.COM" },
  { merchant: "iCloud+", category: "subscriptions", dom: 9, cents: -299, descriptor: "APPLE.COM/BILL" },
  { merchant: "ChatGPT", category: "subscriptions", dom: 12, cents: -2000, descriptor: "OPENAI CHATGPT" },
  { merchant: "PG&E", category: "housing", dom: 15, cents: -8640, descriptor: "PGANDE WEB ONLINE" },
  { merchant: "YouTube Premium", category: "subscriptions", dom: 16, cents: -1399, descriptor: "GOOGLE *YOUTUBE" },
  { merchant: "Comcast Xfinity", category: "housing", dom: 17, cents: -8999, descriptor: "COMCAST CALIFORNIA" },
  { merchant: "Notion", category: "subscriptions", dom: 18, cents: -1200, descriptor: "NOTION LABS INC" },
  { merchant: "SF Water Power Sewer", category: "housing", dom: 20, cents: -6420, descriptor: "SFPUC WATER" },
  { merchant: "NYTimes", category: "subscriptions", dom: 21, cents: -1700, descriptor: "NYTIMES*SUBSCRIPTION" },
  { merchant: "Verizon Wireless", category: "subscriptions", dom: 24, cents: -9200, descriptor: "VZWRLSS*APOCC" },
  { merchant: "Audible", category: "subscriptions", dom: 26, cents: -1495, descriptor: "AUDIBLE*PMT" },
]

// One-off merchant pool — everyday personal noise.
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
  { merchant: "Souvla", category: "dining", min: 1600, max: 4200, descriptor: "SOUVLA HAYES" },
  { merchant: "State Bird Provisions", category: "dining", min: 6800, max: 18500, descriptor: "STATE BIRD PROV" },
  { merchant: "Walgreens", category: "shopping", min: 600, max: 4400, descriptor: "WALGREENS #3721" },
  { merchant: "Shell", category: "transport", min: 3500, max: 7200, descriptor: "SHELL OIL" },
  { merchant: "Clipper", category: "transport", min: 2000, max: 4000, descriptor: "CLIPPER AUTOLOAD" },
]

// Business-account expense pool — SaaS, shipping, supplies, client meals.
const BUSINESS_POOL: { merchant: string; category: Category; min: number; max: number; descriptor: string }[] = [
  { merchant: "AWS", category: "subscriptions", min: 8200, max: 31400, descriptor: "AMAZON WEB SERVICES" },
  { merchant: "Google Workspace", category: "subscriptions", min: 1440, max: 7200, descriptor: "GOOGLE *WORKSPACE" },
  { merchant: "Adobe", category: "subscriptions", min: 5999, max: 8499, descriptor: "ADOBE *CREATIVE CLD" },
  { merchant: "Office Depot", category: "shopping", min: 2400, max: 18900, descriptor: "OFFICE DEPOT #1123" },
  { merchant: "FedEx", category: "shopping", min: 1250, max: 9600, descriptor: "FEDEX 78202" },
  { merchant: "Costco Business", category: "shopping", min: 8900, max: 34200, descriptor: "COSTCO WHSE #0148" },
  { merchant: "Zeitgeist", category: "dining", min: 3200, max: 11800, descriptor: "ZEITGEIST SF" },
  { merchant: "Uber", category: "transport", min: 1400, max: 5200, descriptor: "UBER *TRIP" },
]

// Occasional large one-offs — the memorable purchases a quarter actually has.
const ONE_OFFS: {
  d: number; merchant: string; descriptor: string; cents: number
  category: Category; account: string; card?: string
}[] = [
  { d: 23, merchant: "West Elm", descriptor: "WEST ELM #109 SF", cents: -232500, category: "shopping", account: CREDIT, card: "card_virtual" },
  { d: 37, merchant: "Delta Air Lines", descriptor: "DELTA AIR 0062341", cents: -48920, category: "transport", account: CREDIT, card: "card_virtual" },
  { d: 52, merchant: "Golden Gate Dental", descriptor: "GG DENTAL SF", cents: -41000, category: "other", account: CHECKING },
  { d: 66, merchant: "Hotel Nia", descriptor: "HOTEL NIA MENLO PK", cents: -63780, category: "other", account: CREDIT, card: "card_virtual" },
  { d: 81, merchant: "REI", descriptor: "REI #83 SOMA", cents: -28935, category: "shopping", account: CHECKING, card: "card_physical" },
  { d: 108, merchant: "Apple Store", descriptor: "APPLE STORE R052", cents: -219900, category: "shopping", account: CREDIT, card: "card_virtual" },
  { d: 131, merchant: "Ticketmaster", descriptor: "TICKETMASTER EVENT", cents: -18450, category: "other", account: CREDIT, card: "card_virtual" },
  { d: 156, merchant: "SF Auto Works", descriptor: "SF AUTO WORKS", cents: -87600, category: "transport", account: CHECKING },
]

function timeline(status: Transaction["status"], ts: string) {
  const t = new Date(ts)
  const authoredAt = new Date(t.getTime() - 36 * 3600 * 1000).toISOString()
  if (status === "posted") return [{ state: "Authorized", at: authoredAt }, { state: "Posted", at: ts }]
  if (status === "authorized") return [{ state: "Authorized", at: ts }]
  return [{ state: "Pending", at: ts }]
}

export type MapleScenario = "low-balance"

export const MAPLE_SCENARIOS: MapleScenario[] = ["low-balance"]

/** Scenario balance overrides for the demo's reseed lever. "low-balance"
 *  lands net worth at exactly $54,907.15 — just under the $55,000 watcher
 *  threshold the meeting script uses — while checking and savings keep their
 *  standard values (savings stays above $10,000 so the scripted
 *  $10K savings→checking top-up is executable without overdraft). */
const SCENARIO_BALANCES: Record<MapleScenario, Record<string, number>> = {
  "low-balance": {
    [JOINT]: 600000,
    [INVEST]: 800000,
    [BUSINESS]: 350000,
    [MONEYMARKET]: 114200,
  },
}

export function buildSeed(anchor: Date = new Date(), scenario?: MapleScenario): SeedData {
  const balanceOf = (id: string, standard: number): number =>
    scenario === undefined ? standard : SCENARIO_BALANCES[scenario][id] ?? standard
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

  // Six months of daily history
  for (let day = HISTORY_DAYS; day >= 1; day--) {
    const date = daysAgo(anchor, day)
    const weekday = date.getDay() >= 1 && date.getDay() <= 5

    // Biweekly payroll + the savings sweep it funds
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

    // The weekly grocery run, bigger than the incidental top-ups in the pool
    if (day % 7 === 2) {
      add({ accountId: CHECKING, merchant: "Whole Foods Market", descriptor: "WHOLEFDS SFO",
        amount: between(8000, 16000), timestamp: iso(daysAgo(anchor, day, 17, Math.floor(rand() * 60))),
        category: "groceries", status: "posted", location: "San Francisco, CA", cardId: "card_physical" })
    }

    // Everyday personal noise across checking + credit
    const count = 2 + Math.floor(rand() * 3)
    for (let i = 0; i < count; i++) {
      const m = pick(POOL)
      const hour = 8 + Math.floor(rand() * 13)
      add({ accountId: rand() < 0.25 ? CREDIT : CHECKING, merchant: m.merchant, descriptor: m.descriptor,
        amount: between(m.min, m.max), timestamp: iso(daysAgo(anchor, day, hour, Math.floor(rand() * 60))),
        category: m.category, status: "posted", location: "San Francisco, CA",
        cardId: rand() < 0.25 ? "card_virtual" : "card_physical" })
    }

    // Business checking runs on weekdays
    if (weekday) {
      const bCount = rand() < 0.35 ? 0 : rand() < 0.8 ? 1 : 2
      for (let i = 0; i < bCount; i++) {
        const m = pick(BUSINESS_POOL)
        const hour = 9 + Math.floor(rand() * 9)
        add({ accountId: BUSINESS, merchant: m.merchant, descriptor: m.descriptor,
          amount: between(m.min, m.max), timestamp: iso(daysAgo(anchor, day, hour, Math.floor(rand() * 60))),
          category: m.category, status: "posted", location: "San Francisco, CA",
          cardId: "card_business", method: "Maple Business ·· 3308" })
      }
    }

    // Client revenue lands twice a month on the business account
    if (day % 15 === 5) {
      add({ accountId: BUSINESS, merchant: "Stripe Payout", descriptor: "STRIPE TRANSFER",
        amount: 420000 + Math.floor(rand() * 260000), timestamp: iso(daysAgo(anchor, day, 8, 30)),
        category: "income", status: "posted", method: "ACH deposit" })
    }
    if (day % 15 === 12) {
      add({ accountId: BUSINESS, merchant: "Brightline LLC", descriptor: "ACH BRIGHTLINE LLC INV",
        amount: 610000 + Math.floor(rand() * 340000), timestamp: iso(daysAgo(anchor, day, 10, 15)),
        category: "income", status: "posted", method: "ACH deposit" })
    }
  }

  // Monthly cycles across the half year
  for (let monthsBack = 6; monthsBack >= 0; monthsBack--) {
    const onDom = (dom: number, h = 6, m = 0) => {
      const d = new Date(anchor); d.setMonth(d.getMonth() - monthsBack); d.setDate(dom); d.setHours(h, m, 0, 0)
      return d <= anchor && d >= daysAgo(anchor, HISTORY_DAYS + 3) ? d : null
    }

    // Rent, utilities, subscriptions
    for (const r of RECURRING) {
      const d = onDom(r.dom)
      if (d) {
        add({ accountId: CHECKING, merchant: r.merchant, descriptor: r.descriptor, amount: r.cents,
          timestamp: iso(d), category: r.category, status: "posted",
          recurringId: `rec_${r.merchant.toLowerCase().replace(/[^a-z]/g, "")}` })
      }
    }

    // Monthly auto-invest sweep into Maple Invest
    const invest = onDom(2, 9, 10)
    if (invest) {
      add({ accountId: CHECKING, merchant: "Transfer to Maple Invest", descriptor: "INTERNAL XFER",
        amount: -100000, timestamp: iso(invest), category: "transfer", status: "posted", method: "Internal transfer" })
      add({ accountId: INVEST, merchant: "Transfer from Checking", descriptor: "INTERNAL XFER",
        amount: 100000, timestamp: iso(invest), category: "transfer", status: "posted", method: "Internal transfer" })
    }

    // Joint savings contribution on the 3rd
    const joint = onDom(3, 9, 20)
    if (joint) {
      add({ accountId: CHECKING, merchant: "Transfer to Joint Savings", descriptor: "INTERNAL XFER",
        amount: -75000, timestamp: iso(joint), category: "transfer", status: "posted", method: "Internal transfer" })
      add({ accountId: JOINT, merchant: "Transfer from Checking", descriptor: "INTERNAL XFER",
        amount: 75000, timestamp: iso(joint), category: "transfer", status: "posted", method: "Internal transfer" })
    }

    // Business rent on the 1st
    const wework = onDom(1, 7, 0)
    if (wework) {
      add({ accountId: BUSINESS, merchant: "WeWork SOMA", descriptor: "WEWORK ACH SOMA", amount: -185000,
        timestamp: iso(wework), category: "housing", status: "posted", method: "ACH payment",
        recurringId: "rec_weworksoma" })
    }

    // Credit-card autopay on the 25th — out of checking, onto the card
    const autopay = onDom(25, 8, 0)
    if (autopay) {
      add({ accountId: CHECKING, merchant: "Maple Credit Payment", descriptor: "MAPLE CARD AUTOPAY",
        amount: -85000, timestamp: iso(autopay), category: "transfer", status: "posted", method: "ACH payment" })
      add({ accountId: CREDIT, merchant: "Payment Received", descriptor: "MAPLE CARD AUTOPAY",
        amount: 85000, timestamp: iso(autopay), category: "transfer", status: "posted", method: "ACH payment" })
    }

    // Interest credits on every savings-kind account on the 28th
    const interest = onDom(28, 5, 0)
    if (interest) {
      const post = (accountId: string, base: number) =>
        add({ accountId, merchant: "Interest Earned", descriptor: "INTEREST PAYMENT",
          amount: base + Math.floor(rand() * 400), timestamp: iso(interest), category: "income",
          status: "posted", method: "Interest credit" })
      post(SAVINGS, 9900); post(JOINT, 5200); post(MONEYMARKET, 19100)
    }

    // Quarterly dividend into Maple Invest
    const dividend = onDom(27, 6, 30)
    if (dividend && monthsBack % 3 === 0) {
      add({ accountId: INVEST, merchant: "Vanguard Dividend", descriptor: "VANGUARD DIV VTI",
        amount: 18400 + Math.floor(rand() * 9000), timestamp: iso(dividend), category: "income",
        status: "posted", method: "Dividend" })
    }
  }

  // The memorable one-offs
  for (const x of ONE_OFFS) {
    add({ accountId: x.account, merchant: x.merchant, descriptor: x.descriptor, amount: x.cents,
      timestamp: iso(daysAgo(anchor, x.d, 11 + (x.d % 7), 7 + (x.d % 50))), category: x.category,
      status: "posted", location: "San Francisco, CA", ...(x.card ? { cardId: x.card } : {}) })
  }

  // Annual bonus, then most of it parked in the money market the next morning
  add({ accountId: CHECKING, merchant: "Acme Corp Bonus", descriptor: "ACME CORP BONUS",
    amount: 1500000, timestamp: iso(daysAgo(anchor, 95, 9, 1)), category: "income", status: "posted",
    method: "ACH deposit" })
  add({ accountId: CHECKING, merchant: "Transfer to Money Market", descriptor: "INTERNAL XFER",
    amount: -1000000, timestamp: iso(daysAgo(anchor, 94, 9, 30)), category: "transfer", status: "posted",
    method: "Internal transfer" })
  add({ accountId: MONEYMARKET, merchant: "Transfer from Checking", descriptor: "INTERNAL XFER",
    amount: 1000000, timestamp: iso(daysAgo(anchor, 94, 9, 30)), category: "transfer", status: "posted",
    method: "Internal transfer" })

  // Quarterly estimated taxes out of the business account
  for (const day of [30, 120]) {
    add({ accountId: BUSINESS, merchant: "IRS Estimated Tax", descriptor: "IRS USATAXPYMT",
      amount: -680000, timestamp: iso(daysAgo(anchor, day, 7, 45)), category: "other", status: "posted",
      method: "ACH payment" })
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
    { d: 74, h: 0,  m: 51, merchant: "DoorDash",   descriptor: "DOORDASH*ORDER 3310", cents: -3690, category: "dining",    account: CHECKING, card: "card_physical" },
    { d: 92, h: 1,  m: 12, merchant: "Uber",       descriptor: "UBER *TRIP",          cents: -3150, category: "transport", account: CHECKING, card: "card_physical" },
    { d: 118, h: 2, m: 4,  merchant: "Uber Eats",  descriptor: "UBER EATS SF",        cents: -4210, category: "dining",    account: CHECKING, card: "card_physical" },
    { d: 149, h: 0, m: 36, merchant: "Taco Bell",  descriptor: "TACO BELL 7042",      cents: -1610, category: "dining",    account: CHECKING, card: "card_physical" },
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
    { id: CHECKING, name: "Maple Checking", kind: "checking", mask: "4471", balance: balanceOf(CHECKING, 941220),
      accountNumber: "•••• •••• 4471", routingNumber: "•••••• 021", sparkline: spark(rand, balanceOf(CHECKING, 941220)) },
    { id: SAVINGS, name: "Maple Savings", kind: "savings", mask: "8820", balance: balanceOf(SAVINGS, 2814135), apy: 4.25,
      accountNumber: "•••• •••• 8820", routingNumber: "•••••• 021", sparkline: spark(rand, balanceOf(SAVINGS, 2814135)) },
    { id: JOINT, name: "Maple Joint Savings", kind: "savings", mask: "6114", balance: balanceOf(JOINT, 1523060), apy: 4.1,
      accountNumber: "•••• •••• 6114", routingNumber: "•••••• 021", sparkline: spark(rand, balanceOf(JOINT, 1523060)) },
    { id: CREDIT, name: "Maple Credit", kind: "credit", mask: "0934", balance: -128840, apy: 0,
      accountNumber: "•••• •••• 0934", sparkline: spark(rand, 128840) },
    { id: INVEST, name: "Maple Invest", kind: "investing", mask: "5567", balance: balanceOf(INVEST, 1864200),
      accountNumber: "•••• •••• 5567", sparkline: spark(rand, balanceOf(INVEST, 1864200)) },
    { id: BUSINESS, name: "Maple Business Checking", kind: "checking", mask: "3308", balance: balanceOf(BUSINESS, 2247915),
      accountNumber: "•••• •••• 3308", routingNumber: "•••••• 021", sparkline: spark(rand, balanceOf(BUSINESS, 2247915)) },
    { id: MONEYMARKET, name: "Maple Money Market", kind: "savings", mask: "7702", balance: balanceOf(MONEYMARKET, 5031240), apy: 4.6,
      accountNumber: "•••• •••• 7702", routingNumber: "•••••• 021", sparkline: spark(rand, balanceOf(MONEYMARKET, 5031240)) },
  ]

  const cards: Card[] = [
    { id: "card_physical", accountId: CHECKING, type: "physical", network: "visa", mask: "4471",
      expMonth: 8, expYear: 28, frozen: false, spendLimit: 500000, design: "graphite" },
    { id: "card_virtual", accountId: CREDIT, type: "virtual", network: "visa", mask: "0934",
      expMonth: 3, expYear: 27, frozen: false, spendLimit: 250000, design: "amber" },
    { id: "card_business", accountId: BUSINESS, type: "physical", network: "mastercard", mask: "3308",
      expMonth: 11, expYear: 28, frozen: false, spendLimit: 1000000, design: "forest" },
  ]

  const payees: Payee[] = [
    { id: "pay_jordan", name: "Jordan Avery", kind: "person", mask: "venmo" },
    { id: "pay_landlord", name: "Mission St Property", kind: "biller", mask: "ACH" },
    { id: "pay_pge", name: "PG&E", kind: "biller", mask: "utility" },
    { id: "pay_mom", name: "Mom", kind: "person" },
    { id: "pay_comcast", name: "Comcast Xfinity", kind: "biller", mask: "utility" },
    { id: "pay_sfwater", name: "SF Water Power Sewer", kind: "biller", mask: "utility" },
    { id: "pay_alex", name: "Alex Rivera", kind: "person", mask: "zelle" },
    { id: "pay_dana", name: "Dana Whitfield", kind: "person", mask: "venmo" },
    { id: "pay_maplecard", name: "Maple Credit Autopay", kind: "biller", mask: "autopay" },
    { id: "pay_wework", name: "WeWork SOMA", kind: "biller", mask: "ACH" },
  ]

  const scheduled: ScheduledPayment[] = [
    { id: "sch_rent", payeeId: "pay_landlord", payeeName: "Mission St Property", amount: -285000,
      nextDate: iso(nextDom(anchor, 1)), cadence: "monthly" },
    { id: "sch_wework", payeeId: "pay_wework", payeeName: "WeWork SOMA", amount: -185000,
      nextDate: iso(nextDom(anchor, 1)), cadence: "monthly" },
    { id: "sch_pge", payeeId: "pay_pge", payeeName: "PG&E", amount: -8640,
      nextDate: iso(nextDom(anchor, 15)), cadence: "monthly" },
    { id: "sch_comcast", payeeId: "pay_comcast", payeeName: "Comcast Xfinity", amount: -8999,
      nextDate: iso(nextDom(anchor, 17)), cadence: "monthly" },
    { id: "sch_water", payeeId: "pay_sfwater", payeeName: "SF Water Power Sewer", amount: -6420,
      nextDate: iso(nextDom(anchor, 20)), cadence: "monthly" },
    { id: "sch_cc_autopay", payeeId: "pay_maplecard", payeeName: "Maple Credit Autopay", amount: -85000,
      nextDate: iso(nextDom(anchor, 25)), cadence: "monthly" },
  ]

  const goals: Goal[] = [
    { id: "goal_japan", name: "Japan trip", target: 500000, saved: 312000, icon: "plane" },
    { id: "goal_emergency", name: "Emergency fund", target: 1000000, saved: 740000, icon: "shield" },
    { id: "goal_mac", name: "New MacBook", target: 250000, saved: 90000, icon: "laptop" },
    { id: "goal_house", name: "House down payment", target: 15000000, saved: 6480000, icon: "home" },
    { id: "goal_wedding", name: "Wedding fund", target: 3000000, saved: 1150000, icon: "heart" },
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
    { id: "ntf_5", kind: "deposit", title: "Interest earned", body: "Interest posted to 3 savings accounts",
      at: iso(daysAgo(anchor, 2, 5, 0)), read: false },
    { id: "ntf_6", kind: "alert", title: "Credit autopay scheduled", body: "$850.00 · Maple Credit on the 25th",
      at: iso(daysAgo(anchor, 3, 8, 0)), read: false },
    { id: "ntf_7", kind: "card", title: "Large purchase at West Elm", body: "$2,325.00 · Maple Credit ·· 0934",
      at: iso(daysAgo(anchor, 23, 12, 30)), read: true },
    { id: "ntf_8", kind: "deposit", title: "Stripe payout received", body: "Deposit to Maple Business Checking",
      at: iso(daysAgo(anchor, 5, 8, 30)), read: true },
    { id: "ntf_9", kind: "alert", title: "Japan trip goal at 62%", body: "$3,120.00 of $5,000.00 saved",
      at: iso(daysAgo(anchor, 6, 9, 0)), read: true },
    { id: "ntf_10", kind: "alert", title: "Statement ready", body: "Your Maple Credit statement is available",
      at: iso(daysAgo(anchor, 8, 7, 0)), read: true },
    { id: "ntf_11", kind: "transfer", title: "Transfer completed", body: "$750.00 to Maple Joint Savings",
      at: iso(daysAgo(anchor, 9, 9, 20)), read: true },
    { id: "ntf_12", kind: "security", title: "Password changed", body: "Your Maple password was updated",
      at: iso(daysAgo(anchor, 31, 16, 45)), read: true },
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
