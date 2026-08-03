import { getStore } from "./store"
import type { Account, Profile } from "./types"
import { listTransactions } from "./transactions"

export function listAccounts(): Account[] { return getStore().accounts }
export function getAccount(id: string): Account | undefined {
  return getStore().accounts.find(a => a.id === id)
}
/** `bounds` narrows to a date range, so an automation rehearsal can pin each
 *  firing's window here the same way it does on host_listTransactions — the
 *  ledger is the same one, and a transaction's timestamp is immutable. */
export function getAccountTransactions(
  id: string,
  limit = 50,
  bounds: { from?: string; to?: string } = {},
) {
  return listTransactions({ accountId: id, limit, ...bounds })
}
export function getProfile(): Profile {
  const accts = getStore().accounts
  const netWorth = accts.reduce((s, a) => s + a.balance, 0)
  return { name: "Yousef Helal", email: "yousef@maple.com", netWorth,
    accountCount: accts.length, avatarInitials: "YH" }
}
