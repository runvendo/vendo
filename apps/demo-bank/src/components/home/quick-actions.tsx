"use client"
import { Send, Download, ArrowLeftRight, Receipt, PlusCircle } from "lucide-react"
import { useToast } from "@/components/ui/toast"
import { Card } from "@/components/ui/card"

const ACTIONS = [
  { label: "Send", Icon: Send },
  { label: "Request", Icon: Download },
  { label: "Move money", Icon: ArrowLeftRight },
  { label: "Pay bill", Icon: Receipt },
  { label: "Deposit", Icon: PlusCircle },
]

export function QuickActions() {
  const toast = useToast()
  return (
    <Card className="grid grid-cols-5 divide-x divide-border">
      {ACTIONS.map(({ label, Icon }) => (
        <button
          key={label}
          onClick={() =>
            toast({ title: "Demo only", description: "This action is presentational in the demo." })
          }
          className="flex flex-col items-center justify-center gap-2 py-5 transition-colors hover:bg-hover first:rounded-l-card last:rounded-r-card"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-hover text-ink">
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </span>
          <span className="text-[13px] font-medium text-ink">{label}</span>
        </button>
      ))}
    </Card>
  )
}
