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
