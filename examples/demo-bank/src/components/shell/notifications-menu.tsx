"use client"
import { ArrowDownLeft, CreditCard, AlertTriangle, ShieldCheck, ArrowLeftRight, type LucideIcon } from "lucide-react"
import { Dropdown, DropdownTrigger, DropdownContent } from "@/components/ui/dropdown"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/toast"
import { useNotifications } from "@/lib/hooks"
import { relativeDay } from "@/lib/format"
import { cn } from "@/lib/cn"
import type { Notification } from "@/server/types"

const ICONS: Record<Notification["kind"], LucideIcon> = {
  deposit: ArrowDownLeft,
  card: CreditCard,
  alert: AlertTriangle,
  security: ShieldCheck,
  transfer: ArrowLeftRight,
}

export function NotificationsMenu({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useNotifications()
  const toast = useToast()

  return (
    <Dropdown>
      <DropdownTrigger asChild>{children}</DropdownTrigger>
      <DropdownContent align="end" className="w-[340px] p-0">
        <div className="flex items-center justify-between border-b border-border px-3.5 py-3">
          <span className="text-sm font-semibold text-ink">Notifications</span>
          <button
            className="text-xs text-muted transition-colors hover:text-ink"
            onClick={() => toast({ title: "Demo only", description: "Notifications can't be marked read in this demo." })}
          >
            Mark all read
          </button>
        </div>
        <div className="max-h-[360px] overflow-y-auto p-1">
          {isLoading || !data ? (
            <div className="space-y-2 p-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="h-7 w-7 rounded-full" />
                  <div className="flex-1 space-y-1.5 py-0.5">
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="h-2.5 w-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : data.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted">You&apos;re all caught up.</div>
          ) : (
            data.map((n) => {
              const Icon = ICONS[n.kind]
              return (
                <div
                  key={n.id}
                  className={cn("flex gap-3 rounded-lg px-2.5 py-2.5", !n.read && "bg-hover")}
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-ink-soft">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-ink">{n.title}</span>
                      <span className="shrink-0 text-[11px] text-muted">{relativeDay(n.at)}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">{n.body}</p>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </DropdownContent>
    </Dropdown>
  )
}
