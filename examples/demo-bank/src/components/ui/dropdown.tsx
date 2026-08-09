"use client"
import * as React from "react"
import * as DM from "@radix-ui/react-dropdown-menu"
import { cn } from "@/lib/cn"

export const Dropdown = DM.Root
export const DropdownTrigger = DM.Trigger
export function DropdownContent({ className, align = "end", ...p }: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content
        sideOffset={6}
        align={align}
        className={cn("z-50 min-w-[200px] rounded-xl border border-border bg-surface p-1 shadow-lg", className)}
        {...p}
      />
    </DM.Portal>
  )
}
export function DropdownItem({ className, ...p }: React.ComponentProps<typeof DM.Item>) {
  return (
    <DM.Item
      className={cn("flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-ink outline-none cursor-pointer data-[highlighted]:bg-hover", className)}
      {...p}
    />
  )
}
export const DropdownLabel = DM.Label
export const DropdownSeparator = ({ className, ...p }: React.ComponentProps<typeof DM.Separator>) =>
  <DM.Separator className={cn("my-1 h-px bg-border", className)} {...p} />
