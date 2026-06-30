import * as React from "react"
import { cn } from "@/lib/cn"

type Tone = "neutral" | "positive" | "negative"
const tones: Record<Tone, string> = {
  neutral: "bg-hover text-ink-soft",
  positive: "bg-pos-bg text-pos",
  negative: "bg-neg-bg text-neg",
}
export function Badge({ tone = "neutral", className, children }: {
  tone?: Tone; className?: string; children: React.ReactNode
}) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", tones[tone], className)}>
      {children}
    </span>
  )
}
