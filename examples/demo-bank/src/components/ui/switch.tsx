"use client"
import * as RSwitch from "@radix-ui/react-switch"
import { cn } from "@/lib/cn"

export function Switch({ checked, onCheckedChange, className }: {
  checked?: boolean; onCheckedChange?: (v: boolean) => void; className?: string
}) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={cn("relative h-6 w-10 rounded-full bg-border data-[state=checked]:bg-ink transition-colors", className)}
    >
      <RSwitch.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </RSwitch.Root>
  )
}
