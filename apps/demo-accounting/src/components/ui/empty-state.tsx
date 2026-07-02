import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/cn"

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface text-ink-faint">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <p className="mt-3 text-[13.5px] font-medium">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-ink-faint">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
