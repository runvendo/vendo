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
