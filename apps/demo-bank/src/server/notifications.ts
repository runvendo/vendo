import { getStore } from "./store"
import type { Notification } from "./types"

export function listNotifications(): Notification[] {
  return [...getStore().notifications].sort((a, b) => +new Date(b.at) - +new Date(a.at))
}
