"use client"
import { ChevronsUpDown, LogOut, UserRound } from "lucide-react"
import { Dropdown, DropdownTrigger, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/dropdown"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/toast"
import { useProfile } from "@/lib/hooks"

export function AccountSwitcher() {
  const { data, isLoading } = useProfile()
  const toast = useToast()
  const demo = () => toast({ title: "Demo only", description: "Account actions are disabled in this demo." })

  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-hover">
          {isLoading || !data ? (
            <Skeleton className="h-7 w-7 rounded-full" />
          ) : (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-soft text-[11px] font-semibold text-white">
              {data.avatarInitials}
            </span>
          )}
          <span className="min-w-0 flex-1">
            {isLoading || !data ? (
              <Skeleton className="h-3 w-24" />
            ) : (
              <>
                <span className="block truncate text-[13px] font-medium text-ink">{data.name}</span>
                <span className="block text-[11px] text-muted">Personal</span>
              </>
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted" />
        </button>
      </DropdownTrigger>
      <DropdownContent align="start" className="w-[216px]">
        {data && (
          <div className="px-2.5 py-2">
            <div className="truncate text-[13px] font-medium text-ink">{data.name}</div>
            <div className="truncate text-[11px] text-muted">{data.email}</div>
          </div>
        )}
        <DropdownSeparator />
        <DropdownLabel className="px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted">
          Switch account
        </DropdownLabel>
        <DropdownItem onSelect={demo}>
          <UserRound className="h-4 w-4 text-muted" />
          Personal
        </DropdownItem>
        <DropdownSeparator />
        <DropdownItem onSelect={demo}>
          <LogOut className="h-4 w-4 text-muted" />
          Sign out
        </DropdownItem>
      </DropdownContent>
    </Dropdown>
  )
}
