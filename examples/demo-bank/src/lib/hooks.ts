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

/** The text-channel invite for the signed-in user — `url` is the prefilled
 *  `sms:` link, or null when this deployment has no text channel.
 *
 *  Minted LAZILY and exactly once: the key is null until `enabled` (the modal
 *  opening), and every revalidation trigger is off, because each mint replaces
 *  the user's outstanding code — a refetch would strand the code they are
 *  looking at (or already scanned). */
export const useTextLink = (enabled: boolean) =>
  useSWR<{ url: string | null }>(enabled ? "/api/vendo/text-link" : null, f, {
    // Deliberately quiet: every mint replaces the user's outstanding code, so a
    // focus or reconnect must not silently invalidate the code on their phone.
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    // A failure, though, has nothing to protect — and left alone it would strand
    // the dialog on its loading state for good. `mutate()` from the retry button
    // is the only thing that asks again.
    shouldRetryOnError: false,
  })
