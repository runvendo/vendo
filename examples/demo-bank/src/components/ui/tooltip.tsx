"use client"
import * as RT from "@radix-ui/react-tooltip"
import { cn } from "@/lib/cn"

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <RT.Provider delayDuration={200}>{children}</RT.Provider>
}
export function Tooltip({ content, children }: { content: React.ReactNode; children: React.ReactNode }) {
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content sideOffset={6} className={cn("z-50 rounded-lg bg-ink px-2 py-1 text-xs text-white shadow")}>
          {content}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  )
}
