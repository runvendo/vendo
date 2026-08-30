"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Boxes, Home, Package, Truck, Users } from "lucide-react"
import clsx from "clsx"

const NAV = [
  { href: "/", label: "Overview", icon: Home },
  { href: "/orders", label: "Orders", icon: Package },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/shipments", label: "Shipments", icon: Truck },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl">
      <aside className="hidden w-56 shrink-0 border-r border-border px-4 py-6 md:block">
        <Link href="/" className="mb-8 flex items-center gap-2 px-2">
          <span className="grid size-7 place-items-center rounded-md bg-accent text-sm font-bold text-white">
            C
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Crate</span>
        </Link>

        <nav className="space-y-0.5">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={clsx(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  active
                    ? "bg-accent-bg font-medium text-accent"
                    : "text-ink-soft hover:bg-hover hover:text-ink",
                )}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            )
          })}
        </nav>
      </aside>

      <main className="min-w-0 flex-1 px-5 py-6 md:px-8">{children}</main>
    </div>
  )
}
