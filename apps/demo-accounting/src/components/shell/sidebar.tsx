"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Blocks,
  CalendarDays,
  ClipboardList,
  Inbox,
  LayoutDashboard,
  Settings,
  Sparkles,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react"
import { CadenceLogo } from "@/components/brand"
import { cn } from "@/lib/cn"

interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

const NAV_GROUPS: { label: string | null; items: NavItem[] }[] = [
  {
    label: null,
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      // The embedded Flowlet page surface (host-named Vendo in this demo).
      { href: "/assistant", label: "Vendo", icon: Sparkles },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href: "/clients", label: "Clients", icon: Users },
      { href: "/work", label: "Work", icon: ClipboardList },
      { href: "/calendar", label: "Calendar", icon: CalendarDays },
      { href: "/inbox", label: "Inbox", icon: Inbox },
    ],
  },
  {
    label: "Firm",
    items: [
      { href: "/team", label: "Team", icon: UsersRound },
      { href: "/integrations", label: "Integrations", icon: Blocks },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
]

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`)
}

export function Sidebar() {
  const pathname = usePathname()
  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col bg-evergreen-950">
      <div className="flex h-14 items-center px-5">
        <Link href="/" aria-label="Cadence dashboard">
          <CadenceLogo tone="light" />
        </Link>
      </div>
      <nav className="mt-3 flex-1 space-y-6 overflow-y-auto px-3" aria-label="Main">
        {NAV_GROUPS.map(group => (
          <div key={group.label ?? "root"}>
            {group.label && (
              <p className="px-2.5 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-evergreen-100/40 uppercase">
                {group.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map(item => {
                const active = isActive(pathname, item.href)
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                        active
                          ? "bg-white/10 text-white"
                          : "text-evergreen-100/65 hover:bg-white/5 hover:text-white",
                      )}
                    >
                      <item.icon
                        size={15}
                        strokeWidth={1.75}
                        className={cn(active ? "text-evergreen-300" : "text-evergreen-100/45")}
                      />
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-white/8 px-5 py-4">
        <p className="text-[11px] font-medium text-evergreen-100/50">Hartwell &amp; Associates</p>
        <p className="mt-0.5 text-[10.5px] text-evergreen-100/30">Tax season 2026</p>
      </div>
    </aside>
  )
}
