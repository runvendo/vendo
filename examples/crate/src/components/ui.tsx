import clsx from "clsx"
import { titleCase } from "@/lib/format"

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <section
      className={clsx("rounded-card border border-border bg-surface", className)}
    >
      {children}
    </section>
  )
}

export function CardHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {action}
    </div>
  )
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
    </div>
  )
}

/** Status colour carries meaning here: red is money or delivery going wrong. */
const TONE: Record<string, string> = {
  pending: "bg-hover text-ink-soft",
  paid: "bg-accent-bg text-accent",
  fulfilled: "bg-accent-bg text-accent",
  shipped: "bg-warn-bg text-warn",
  delivered: "bg-pos-bg text-pos",
  cancelled: "bg-hover text-muted",
  refunded: "bg-neg-bg text-neg",
  label_created: "bg-hover text-ink-soft",
  in_transit: "bg-warn-bg text-warn",
  out_for_delivery: "bg-warn-bg text-warn",
  exception: "bg-neg-bg text-neg",
  returned: "bg-neg-bg text-neg",
  succeeded: "bg-pos-bg text-pos",
  failed: "bg-neg-bg text-neg",
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE[status] ?? "bg-hover text-ink-soft",
      )}
    >
      {titleCase(status)}
    </span>
  )
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="px-4 py-3.5">
      <p className="text-xs text-muted">{label}</p>
      <p className="nums mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </Card>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted">{children}</p>
}

export function Th({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <th className={clsx("px-4 py-2 text-left text-xs font-medium text-muted", className)}>
      {children}
    </th>
  )
}

export function Td({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <td className={clsx("px-4 py-2.5 text-sm", className)}>{children}</td>
}
