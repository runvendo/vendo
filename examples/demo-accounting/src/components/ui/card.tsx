import { cn } from "@/lib/cn"

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-xl border border-line bg-card shadow-card", className)}
      {...props}
    />
  )
}

/** Card header row: title on the left, optional action (link/button) on the right. */
export function CardHeader({
  title,
  action,
  className,
}: {
  title: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-center justify-between px-5 pt-4 pb-3", className)}>
      <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
      {action}
    </div>
  )
}
