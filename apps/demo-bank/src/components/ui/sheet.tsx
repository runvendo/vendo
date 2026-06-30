"use client"
import * as React from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { cn } from "@/lib/cn"

export const Sheet = Dialog.Root
export const SheetTrigger = Dialog.Trigger
export function SheetContent({ className, side = "right", ...p }: React.ComponentProps<typeof Dialog.Content> & { side?: "right" | "center" }) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/20" />
      <Dialog.Content
        className={cn(
          "fixed z-50 bg-surface shadow-xl focus:outline-none",
          side === "right"
            ? "right-0 top-0 h-full w-[420px] border-l border-border"
            : "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] rounded-2xl border border-border",
          className,
        )}
        {...p}
      />
    </Dialog.Portal>
  )
}
export const SheetTitle = Dialog.Title
export const SheetClose = Dialog.Close
