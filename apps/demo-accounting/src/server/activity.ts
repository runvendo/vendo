import { getStore } from "./store"
import type { ActivityEvent, ActivityType } from "./types"

let counter = 0

/** Prepend an event to the firm-wide activity feed (newest first). */
export function recordActivity(
  type: ActivityType,
  summary: string,
  clientId?: string,
): ActivityEvent {
  const event: ActivityEvent = {
    id: `act_live_${++counter}`,
    type,
    ...(clientId ? { clientId } : {}),
    summary,
    at: new Date().toISOString(),
  }
  getStore().activity.unshift(event)
  return event
}
