import { Wallet, PiggyBank, CreditCard, TrendingUp, type LucideIcon } from "lucide-react"
import type { AccountKind } from "@/server/types"

export const KIND_ICON: Record<AccountKind, LucideIcon> = {
  checking: Wallet,
  savings: PiggyBank,
  credit: CreditCard,
  investing: TrendingUp,
}

export const KIND_LABEL: Record<AccountKind, string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit",
  investing: "Investing",
}
