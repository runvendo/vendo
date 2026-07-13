"use client"
import { Command } from "cmdk"
import { useRouter } from "next/navigation"
import { Search } from "lucide-react"
import { PRIMARY_NAV, SECONDARY_NAV } from "./nav"
import { useTransactions } from "@/lib/hooks"
import { formatAmount } from "@/lib/money"

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { data: txns } = useTransactions("?limit=8")

  const go = (href: string) => {
    onOpenChange(false)
    router.push(href)
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      overlayClassName="fixed inset-0 z-50 bg-ink/20 backdrop-blur-[2px]"
      contentClassName="fixed left-1/2 top-[20%] z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-card border border-border bg-surface shadow-xl"
    >
      <div className="flex items-center gap-2.5 border-b border-border px-4">
        <Search className="h-4 w-4 shrink-0 text-muted" />
        <Command.Input
          placeholder="Search Maple…"
          className="h-12 w-full bg-transparent text-sm text-ink outline-none placeholder:text-muted"
        />
      </div>
      <Command.List className="max-h-[360px] overflow-y-auto p-2">
        <Command.Empty className="px-2 py-8 text-center text-sm text-muted">No results.</Command.Empty>

        <Command.Group
          heading="Navigate"
          className="text-[11px] font-medium uppercase tracking-wide text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2"
        >
          {[...PRIMARY_NAV, ...SECONDARY_NAV].map((item) => {
            const Icon = item.icon
            return (
              <Command.Item
                key={item.href}
                value={item.label}
                onSelect={() => go(item.href)}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm text-ink data-[selected=true]:bg-hover"
              >
                <Icon className="h-4 w-4 text-muted" />
                {item.label}
              </Command.Item>
            )
          })}
        </Command.Group>

        {txns && txns.data.length > 0 && (
          <Command.Group
            heading="Recent transactions"
            className="text-[11px] font-medium uppercase tracking-wide text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2"
          >
            {txns.data.map((t) => (
              <Command.Item
                key={t.id}
                value={`${t.merchant} ${t.id}`}
                onSelect={() => go(`/transactions/${t.id}`)}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm text-ink data-[selected=true]:bg-hover"
              >
                <span className="truncate">{t.merchant}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted">{formatAmount(t.amount)}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  )
}
