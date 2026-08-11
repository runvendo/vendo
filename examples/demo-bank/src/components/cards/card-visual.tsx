"use client"
import { Snowflake } from "lucide-react"
import type { Card } from "@/server/types"
import { cn } from "@/lib/cn"

const CARDHOLDER = "YOUSEF HELAL"

/** Crisp card network mark drawn directly (favicons look muddy on the card face). */
function CardNetwork({ network }: { network: Card["network"] }) {
  if (network === "mastercard") {
    return (
      <svg viewBox="0 0 48 30" className="h-7 w-auto" aria-label="Mastercard">
        <circle cx="19" cy="15" r="11" fill="#EB001B" />
        <circle cx="29" cy="15" r="11" fill="#F79E1B" fillOpacity="0.85" />
      </svg>
    )
  }
  return (
    <span className="text-[22px] font-bold italic leading-none tracking-wide text-white">VISA</span>
  )
}

export function CardVisual({ card, revealed }: { card: Card; revealed?: boolean }) {
  const isAmber = card.design === "amber"
  const number = revealed
    ? `4242 4242 4242 ${card.mask}`
    : `•••• •••• •••• ${card.mask}`
  const exp = `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).padStart(2, "0")}`

  return (
    <div
      className={cn(
        "relative aspect-[1.586] w-full overflow-hidden rounded-2xl p-5 text-white shadow-[0_1px_2px_rgba(0,0,0,.2),0_18px_40px_-20px_rgba(0,0,0,.45)]",
        isAmber
          ? "bg-[linear-gradient(135deg,#3a2a17,#6b4a23_60%,#8a6a3b)]"
          : "bg-[linear-gradient(135deg,#1c1c1e,#2c2c2e_60%,#3a3a3c)]",
      )}
    >
      {/* faint sheen */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_80%_at_15%_0%,rgba(255,255,255,.14),transparent_55%)]"
      />

      <div className="relative flex h-full flex-col justify-between">
        {/* Top row */}
        <div className="flex items-start justify-between">
          <span className="text-[15px] font-semibold tracking-tight">Maple</span>
          <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-white/90">
            {card.type === "physical" ? "Physical" : "Virtual"}
          </span>
        </div>

        {/* Middle: card number */}
        <div className="font-mono text-[18px] tracking-[0.12em] tabular-nums sm:text-[20px]">
          {number}
        </div>

        {/* Bottom row */}
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[11px] font-medium uppercase tracking-[0.06em] text-white/90">
              {CARDHOLDER}
            </div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-white/65">
              Exp <span className="tabular-nums">{exp}</span>
            </div>
          </div>
          <CardNetwork network={card.network} />
        </div>
      </div>

      {/* Frozen overlay */}
      {card.frozen && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-white/10 backdrop-blur-md">
          <Snowflake className="h-6 w-6 text-white" />
          <span className="text-xs font-semibold uppercase tracking-[0.1em] text-white">Frozen</span>
        </div>
      )}
    </div>
  )
}
