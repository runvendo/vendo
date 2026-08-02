import { LayoutGrid, Wallet, ArrowLeftRight, CreditCard, Send, PieChart, Sparkles, Blocks, Bell, Settings, type LucideIcon } from "lucide-react"

export interface NavItem { label: string; href: string; icon: LucideIcon }
export const PRIMARY_NAV: NavItem[] = [
  { label: "Home", href: "/", icon: LayoutGrid },
  { label: "Accounts", href: "/accounts", icon: Wallet },
  { label: "Transactions", href: "/transactions", icon: ArrowLeftRight },
  { label: "Cards", href: "/cards", icon: CreditCard },
  { label: "Payments", href: "/payments", icon: Send },
  { label: "Insights", href: "/insights", icon: PieChart },
  { label: "Ask Maple", href: "/vendo", icon: Sparkles },
  { label: "Apps", href: "/vendo/apps", icon: Blocks },
]
export const SECONDARY_NAV: NavItem[] = [
  { label: "Activity", href: "/activity", icon: Bell },
  { label: "Settings", href: "/settings", icon: Settings },
]
export function titleForPath(path: string): string {
  const all = [...PRIMARY_NAV, ...SECONDARY_NAV]
  const exact = all.find((n) => n.href === path)
  if (exact) return exact.label
  const seg = all.find((n) => n.href !== "/" && path.startsWith(n.href))
  return seg?.label ?? "Maple"
}
