"use client"
import * as React from "react"
import * as RTabs from "@radix-ui/react-tabs"
import { cn } from "@/lib/cn"

export const Tabs = RTabs.Root
export function TabsList({ className, ...p }: React.ComponentProps<typeof RTabs.List>) {
  return <RTabs.List className={cn("inline-flex items-center gap-1 border-b border-border", className)} {...p} />
}
export function TabsTrigger({ className, ...p }: React.ComponentProps<typeof RTabs.Trigger>) {
  return (
    <RTabs.Trigger
      className={cn(
        "px-3 py-2 text-sm font-medium text-muted -mb-px border-b-2 border-transparent transition-colors",
        "data-[state=active]:text-ink data-[state=active]:border-ink",
        className,
      )}
      {...p}
    />
  )
}
export const TabsContent = RTabs.Content
