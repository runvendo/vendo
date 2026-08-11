import { getStore } from "./store"
import type { Payee, ScheduledPayment, Goal } from "./types"

export function listPayees(): Payee[] { return getStore().payees }
export function listScheduled(): ScheduledPayment[] { return getStore().scheduled }
export function listGoals(): Goal[] { return getStore().goals }
