"use client"
import * as React from "react"
import { useCards, useTransactions } from "@/lib/hooks"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Segmented } from "@/components/ui/segmented"
import { TransactionRow } from "@/components/transactions/transaction-row"
import { CardVisual } from "@/components/cards/card-visual"
import { CardControls } from "@/components/cards/card-controls"

function CardTransactions({ cardId }: { cardId: string }) {
  const { data, isLoading } = useTransactions(`?cardId=${cardId}&limit=15`)
  const txns = data?.data

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent transactions on this card</CardTitle>
      </CardHeader>
      <CardContent className="px-1.5 pb-2">
        {isLoading || !txns ? (
          <div className="space-y-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-2.5 py-3">
                <Skeleton className="h-9 w-9 rounded-[10px]" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-44" />
                </div>
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        ) : txns.length === 0 ? (
          <div className="px-3.5 py-10 text-center text-sm text-muted">
            No transactions on this card yet.
          </div>
        ) : (
          <div className="flex flex-col">
            {txns.map((t) => (
              <TransactionRow key={t.id} t={t} showTime />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function CardsPage() {
  const { data: cards, isLoading } = useCards()

  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [frozenById, setFrozenById] = React.useState<Record<string, boolean>>({})
  const [revealedById, setRevealedById] = React.useState<Record<string, boolean>>({})

  const selected = cards?.find((c) => c.id === selectedId) ?? cards?.[0]

  if (isLoading || !cards || !selected) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Cards</h1>
          <p className="text-sm text-muted">Manage your Maple cards.</p>
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="aspect-[1.586] w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-card" />
        </div>
      </div>
    )
  }

  const frozen = frozenById[selected.id] ?? selected.frozen
  const revealed = revealedById[selected.id] ?? false
  const setFrozen = (v: boolean) => setFrozenById((s) => ({ ...s, [selected.id]: v }))
  const setRevealed = (v: boolean) => setRevealedById((s) => ({ ...s, [selected.id]: v }))

  // Reflect the locally-toggled frozen state on the rendered visual.
  const visualCard = { ...selected, frozen }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Cards</h1>
          <p className="text-sm text-muted">Manage your Maple cards.</p>
        </div>
        {cards.length > 1 && (
          <Segmented
            options={cards.map((c) => ({
              label: `${c.type === "physical" ? "Physical" : "Virtual"} ·· ${c.mask}`,
              value: c.id,
            }))}
            value={selected.id}
            onChange={setSelectedId}
          />
        )}
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <div className="mx-auto w-full max-w-md lg:mx-0">
          <CardVisual card={visualCard} revealed={revealed} />
        </div>
        <CardControls
          key={selected.id}
          card={selected}
          frozen={frozen}
          onFrozenChange={setFrozen}
          revealed={revealed}
          onRevealedChange={setRevealed}
        />
      </div>

      <CardTransactions cardId={selected.id} />
    </div>
  )
}
