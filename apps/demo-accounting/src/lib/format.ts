import type { EntityType } from "@/server/types"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5m ago", "2h ago", "3d ago", then a short date. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const elapsed = now.getTime() - new Date(iso).getTime()
  if (elapsed < MINUTE) return "just now"
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`
  return formatDate(iso, now)
}

/** Whole days from today until the date (calendar days, not 24h windows). */
export function daysUntil(iso: string, now: Date = new Date()): number {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((startOfDay(new Date(iso)) - startOfDay(now)) / DAY)
}

/** "Jul 17" this year, "Jul 17, 2027" otherwise. */
export function formatDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  })
}

export const ENTITY_LABELS: Record<EntityType, string> = {
  s_corp: "S-Corp",
  c_corp: "C-Corp",
  sole_prop: "Sole Prop",
  partnership: "Partnership",
  individual: "Individual",
}

export function entityLabel(type: EntityType): string {
  return ENTITY_LABELS[type]
}
