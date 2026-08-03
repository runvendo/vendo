import { getStore } from "./store"
import { listTransactions } from "./transactions"
import type { Card } from "./types"

export function listCards(): Card[] { return getStore().cards }
export function getCard(id: string): Card | undefined { return getStore().cards.find(c => c.id === id) }
/** `bounds` narrows to a date range — see getAccountTransactions in ./accounts
 *  for why the ledger tools all accept one. */
export function getCardTransactions(
  id: string,
  limit = 25,
  bounds: { from?: string; to?: string } = {},
) {
  return listTransactions({ cardId: id, limit, ...bounds })
}
