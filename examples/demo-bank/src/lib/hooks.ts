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
