"use client"
import { usePathname } from "next/navigation"
import { Search, Bell } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/toast"
import { useNotifications } from "@/lib/hooks"
import { titleForPath } from "./nav"
import { NotificationsMenu } from "./notifications-menu"

export function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const pathname = usePathname()
  const toast = useToast()
  const { data: notifications } = useNotifications()
  const hasUnread = !!notifications?.some((n) => !n.read)

  const demo = (title: string, description: string) => () => toast({ title, description })

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-border bg-bg/80 px-6 backdrop-blur">
      <div className="flex items-center gap-5">
        <h1 className="text-lg font-semibold tracking-tight text-ink">{titleForPath(pathname)}</h1>
        <button
          onClick={onOpenPalette}
          className="flex h-9 w-72 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm text-muted transition-colors hover:bg-hover"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="rounded border border-border bg-bg px-1.5 py-0.5 text-[11px] font-medium text-muted">⌘K</kbd>
        </button>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={demo("Demo only", "Sending money is disabled in this demo.")}>
          Send
        </Button>
        <Button size="sm" variant="secondary" onClick={demo("Demo only", "Requesting money is disabled in this demo.")}>
          Request
        </Button>
        <Button size="sm" variant="secondary" onClick={demo("Demo only", "Moving money is disabled in this demo.")}>
          Move money
        </Button>
        <NotificationsMenu>
          <button
            aria-label="Notifications"
            className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink transition-colors hover:bg-hover"
          >
            <Bell className="h-4 w-4" />
            {hasUnread && (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full border border-bg bg-neg" />
            )}
          </button>
        </NotificationsMenu>
      </div>
    </header>
  )
}
