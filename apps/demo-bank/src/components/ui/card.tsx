import * as React from "react"
import { cn } from "@/lib/cn"

export function Card({ className, hover, ...props }: React.HTMLAttributes<HTMLDivElement> & { hover?: boolean }) {
  return (
    <div
      className={cn(
        "bg-surface border border-border rounded-card",
        hover && "transition-shadow hover:shadow-[0_1px_3px_rgba(17,17,17,.06),0_10px_28px_-14px_rgba(17,17,17,.12)]",
        className,
      )}
      {...props}
    />
  )
}
export function CardHeader({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pt-5 pb-3 flex items-center justify-between", className)} {...p} />
}
export function CardTitle({ className, ...p }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-[11px] uppercase tracking-[0.08em] text-muted font-semibold", className)} {...p} />
}
export function CardContent({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5", className)} {...p} />
}
