"use client"
import * as React from "react"
import { Snowflake, Eye, EyeOff, Copy, Wallet } from "lucide-react"
import type { Card as CardType } from "@/server/types"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Segmented } from "@/components/ui/segmented"
import { Tooltip } from "@/components/ui/tooltip"
import { useToast } from "@/components/ui/toast"
import { formatUSD } from "@/lib/money"

const LIMITS = [
  { label: "$1k", value: "100000" },
  { label: "$2.5k", value: "250000" },
  { label: "$5k", value: "500000" },
  { label: "$10k", value: "1000000" },
] as const

function ControlRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{label}</div>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export function CardControls({
  card,
  frozen,
  onFrozenChange,
  revealed,
  onRevealedChange,
}: {
  card: CardType
  frozen: boolean
  onFrozenChange: (v: boolean) => void
  revealed: boolean
  onRevealedChange: (v: boolean) => void
}) {
  const toast = useToast()
  const initialLimit = LIMITS.find((l) => l.value === String(card.spendLimit))?.value ?? LIMITS[2].value
  const [limit, setLimit] = React.useState<string>(initialLimit)

  const toggleFreeze = (v: boolean) => {
    onFrozenChange(v)
    toast({ title: v ? "Card frozen" : "Card unfrozen", description: "Demo only." })
  }

  const changeLimit = (v: string) => {
    setLimit(v)
    toast({ title: "Limit updated", description: "Demo only." })
  }

  const copyNumber = async () => {
    const value = revealed ? `4242 4242 4242 ${card.mask}` : `•••• •••• •••• ${card.mask}`
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // clipboard may be unavailable; still surface the demo toast
    }
    toast({ title: "Copied", description: "Card number copied." })
  }

  return (
    <Card className="divide-y divide-border">
      <CardContent className="p-0">
        <ControlRow
          label="Freeze card"
          description={frozen ? "Card is frozen." : "Temporarily block all transactions."}
        >
          <Snowflake className="h-4 w-4 text-muted" />
          <Switch checked={frozen} onCheckedChange={toggleFreeze} />
        </ControlRow>
      </CardContent>

      <CardContent className="p-0">
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-ink">Spending limit</div>
              <div className="mt-0.5 text-xs text-muted">Per-month cap on this card.</div>
            </div>
            <div className="text-sm font-semibold tabular-nums text-ink">
              {formatUSD(Number(limit))}
            </div>
          </div>
          <Segmented
            options={LIMITS.map((l) => ({ label: l.label, value: l.value }))}
            value={limit}
            onChange={changeLimit}
          />
        </div>
      </CardContent>

      <CardContent className="p-0">
        <ControlRow
          label="Reveal details"
          description="Show the full card number."
        >
          <Tooltip content="Copy card number">
            <Button variant="ghost" size="sm" onClick={copyNumber} aria-label="Copy card number">
              <Copy className="h-4 w-4" />
            </Button>
          </Tooltip>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRevealedChange(!revealed)}
            aria-label={revealed ? "Hide card number" : "Reveal card number"}
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </ControlRow>
      </CardContent>

      <CardContent className="p-0">
        <div className="px-5 py-4">
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => toast({ title: "Add to Apple Wallet", description: "Demo only." })}
          >
            <Wallet className="h-4 w-4" />
            Add to Apple Wallet
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
