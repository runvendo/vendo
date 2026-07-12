import { getStore } from "./store"
import { listTransactions } from "./transactions"
import type { Card } from "./types"

export function listCards(): Card[] { return getStore().cards }
export function getCard(id: string): Card | undefined { return getStore().cards.find(c => c.id === id) }
export function getCardTransactions(id: string, limit = 25) {
  return listTransactions({ cardId: id, limit })
}
