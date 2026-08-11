"use client"
import { ChevronsUpDown, LogOut, UserRound } from "lucide-react"
import { Dropdown, DropdownTrigger, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator } from "@/components/ui/dropdown"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/components/ui/toast"
import { withBasePath } from "@/lib/base-path"
import { useProfile } from "@/lib/hooks"

export function AccountSwitcher() {
  const { data, isLoading } = useProfile()
  const toast = useToast()
  // Build contract §9.1 (E8) — the switcher is real: one entry per seeded
  // staff member, each landing on the existing /login credentials flow with
  // that person's email prefilled. Two real people in one org is what makes
  // sharing, the fork offer and revoke provable in a browser.
  const staff = data?.staff ?? []
  const switchTo = (email: string) => {
    const returnTo = `${window.location.pathname}${window.location.search}`
    window.location.assign(`/login?email=${encodeURIComponent(email)}&returnTo=${encodeURIComponent(returnTo)}`)
  }
  // Real sign-out: POST /logout clears the Auth.js session cookie server-side,
  // then land on /login (pages 401/redirect there without a session anyway).
  const signout = async () => {
    try {
      await fetch(withBasePath("/logout"), { method: "POST" })
    } finally {
      window.location.href = withBasePath("/login")
    }
  }

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
        {staff.length === 0 ? (
          // Honest about WHY there is nobody to switch to: the roster is empty
          // exactly when password login is unconfigured (production without
          // MAPLE_DEMO_PASSWORD), and the fix is one env var. Saying "Personal"
          // here made a configuration gap look like a feature that does nothing.
          <DropdownItem
            onSelect={() => toast({
              title: "Account switching is off",
              description: "Set MAPLE_DEMO_PASSWORD on this deployment to sign in as the other seeded user.",
            })}
          >
            <UserRound className="h-4 w-4 text-muted" />
            Switching unavailable
          </DropdownItem>
        ) : (
          staff.map((member) => {
            const isCurrent = member.email === data?.email
            return (
              <DropdownItem
                key={member.subject}
                onSelect={() => (isCurrent ? undefined : switchTo(member.email))}
              >
                <UserRound className="h-4 w-4 text-muted" />
                {member.display}
                {isCurrent ? <span className="ml-auto text-[11px] text-muted">Current</span> : null}
              </DropdownItem>
            )
          })
        )}
        <DropdownSeparator />
        <DropdownItem onSelect={() => void signout()}>
          <LogOut className="h-4 w-4 text-muted" />
          Sign out
        </DropdownItem>
      </DropdownContent>
    </Dropdown>
  )
}
