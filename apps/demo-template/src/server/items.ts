import { getStore } from "./store"
import type { Item } from "./types"

export function listItems(): Item[] {
  return getStore().items
}

export class ItemError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ItemError"
  }
}

/** The example mutation — the "real action with consent" beat acts through
 * this. Archives an item in the in-memory store; unknown ids are a clean
 * error the agent can relay. */
export function archiveItem(id: string): Item {
  const item = getStore().items.find((i) => i.id === id)
  if (!item) throw new ItemError(`Unknown item: ${id}`)
  item.status = "archived"
  item.updatedAt = new Date().toISOString()
  return item
}
