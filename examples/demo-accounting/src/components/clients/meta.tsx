// Shared client/document presentation metadata for the /clients surfaces.
// Status tints stay within the reserved document/deadline palette (badge.tsx).

import {
  FileCheck2,
  FileClock,
  FileQuestion,
  FileSearch,
  FileX2,
  type LucideIcon,
} from "lucide-react"
import type { BadgeVariant } from "@/components/ui/badge"
import { cn } from "@/lib/cn"
import type { ClientStatus } from "@/server/clients"
import type { DocumentStatus } from "@/server/types"

export const CLIENT_STATUS_META: Record<ClientStatus, { label: string; variant: BadgeVariant }> = {
  missing_docs: { label: "Missing documents", variant: "missing" },
  in_review: { label: "In review", variant: "review" },
  complete: { label: "Complete", variant: "verified" },
}

export const DOC_STATUS_META: Record<
  DocumentStatus,
  { label: string; variant: BadgeVariant; icon: LucideIcon }
> = {
  missing: { label: "Missing", variant: "missing", icon: FileQuestion },
  received: { label: "Received", variant: "neutral", icon: FileClock },
  needs_review: { label: "Needs review", variant: "review", icon: FileSearch },
  verified: { label: "Verified & filed", variant: "verified", icon: FileCheck2 },
  rejected: { label: "Rejected", variant: "overdue", icon: FileX2 },
}

/** Deadline urgency chip: overdue/today = red, within 3 weeks = amber, else neutral. */
export function deadlineUrgency(days: number): { variant: BadgeVariant; label: string } {
  if (days < 0) return { variant: "overdue", label: `${-days}d overdue` }
  if (days === 0) return { variant: "overdue", label: "Due today" }
  if (days <= 21) return { variant: "missing", label: `in ${days} days` }
  return { variant: "neutral", label: `in ${days} days` }
}

export function Avatar({ initials, className }: { initials: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[10px] font-semibold text-white",
        className,
      )}
    >
      {initials}
    </span>
  )
}
