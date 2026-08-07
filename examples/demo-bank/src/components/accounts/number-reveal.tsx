"use client"
import * as React from "react"
import { Eye, EyeOff, Copy } from "lucide-react"
import type { Account } from "@/server/types"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { useToast } from "@/components/ui/toast"

function NumberRow({ label, value }: { label: string; value: string }) {
  const toast = useToast()
  const [revealed, setRevealed] = React.useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // clipboard may be unavailable; still surface the demo toast
    }
    toast({ title: "Copied", description: `${label} copied.` })
  }

  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</div>
        <div className="mt-0.5 text-sm font-medium tabular-nums text-ink">{value}</div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
        >
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
        <Tooltip content={`Copy ${label.toLowerCase()}`}>
          <Button variant="ghost" size="sm" onClick={copy} aria-label={`Copy ${label}`}>
            <Copy className="h-4 w-4" />
          </Button>
        </Tooltip>
      </div>
    </div>
  )
}

export function NumberReveal({ account }: { account: Account }) {
  return (
    <Card className="divide-y divide-border">
      <NumberRow label="Account number" value={account.accountNumber} />
      {account.routingNumber && <NumberRow label="Routing number" value={account.routingNumber} />}
    </Card>
  )
}
