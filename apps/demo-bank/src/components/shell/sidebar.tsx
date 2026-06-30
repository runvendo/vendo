"use client"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/cn"
import { useProfile } from "@/lib/hooks"
import { PRIMARY_NAV, SECONDARY_NAV, type NavItem } from "./nav"
import { AccountSwitcher } from "./account-switcher"

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href)
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item.href)
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      title={item.label}
      className={cn(
        "flex items-center justify-center gap-3 rounded-lg px-2.5 py-2 text-[13px] transition-colors lg:justify-start",
        active ? "bg-hover font-medium text-ink" : "text-muted hover:bg-hover hover:text-ink",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="hidden lg:inline">{item.label}</span>
    </Link>
  )
}

export function Sidebar() {
  const pathname = usePathname()
  const { data: profile } = useProfile()
  return (
    <aside className="flex h-screen w-16 shrink-0 flex-col overflow-hidden border-r border-border bg-surface lg:w-[248px]">
      <div className="flex items-center justify-center gap-2.5 px-0 py-5 lg:justify-start lg:px-5">
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px] bg-ink text-[15px] font-bold text-white">
          M
        </span>
        <span className="hidden text-[15px] font-semibold tracking-tight text-ink lg:inline">Maple</span>
      </div>

      <nav className="flex flex-1 flex-col px-3">
        <div className="flex flex-col gap-0.5">
          {PRIMARY_NAV.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex flex-col gap-0.5 pb-2">
          {SECONDARY_NAV.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
        </div>
      </nav>

      <div className="border-t border-border p-3">
        <div className="hidden lg:block">
          <AccountSwitcher />
        </div>
        <div className="flex justify-center lg:hidden">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-soft text-[11px] font-semibold text-white">
            {profile?.avatarInitials ?? ""}
          </span>
        </div>
      </div>
    </aside>
  )
}
