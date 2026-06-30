"use client"
import { useState } from "react"

const ITEMS = [
  { name: "Crunchwrap Supreme", qty: 2, price: 12.98 },
  { name: "Nachos BellGrande", qty: 1, price: 5.99 },
  { name: "Baja Blast (Large)", qty: 2, price: 5.58 },
  { name: "Cinnamon Twists", qty: 1, price: 2.49 },
]
const SUBTOTAL = ITEMS.reduce((s, i) => s + i.price, 0)
const FEES = 4.8
const TOTAL = SUBTOTAL + FEES

export default function OrderPage() {
  const [state, setState] = useState<"idle" | "placing" | "placed">("idle")

  const placeOrder = async () => {
    setState("placing")
    try {
      await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amountCents: Math.round(TOTAL * 100),
          items: "Taco Bell · late-night delivery",
        }),
      })
      setState("placed")
    } catch {
      setState("idle")
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Late-night eats</h1>
        <p className="text-sm text-muted">DoorDash · Taco Bell · delivering now · 1:32 AM</p>
      </div>

      <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <div className="space-y-3">
          {ITEMS.map((i) => (
            <div key={i.name} className="flex items-center justify-between text-sm">
              <span className="text-ink">
                <span className="text-muted">{i.qty}×</span> {i.name}
              </span>
              <span className="tabular-nums text-ink">${i.price.toFixed(2)}</span>
            </div>
          ))}
        </div>
        <div className="my-4 h-px bg-border" />
        <div className="flex items-center justify-between text-sm text-muted">
          <span>Subtotal</span>
          <span className="tabular-nums">${SUBTOTAL.toFixed(2)}</span>
        </div>
        <div className="flex items-center justify-between text-sm text-muted">
          <span>Fees & delivery</span>
          <span className="tabular-nums">${FEES.toFixed(2)}</span>
        </div>
        <div className="mt-3 flex items-center justify-between text-base font-semibold text-ink">
          <span>Total</span>
          <span className="tabular-nums">${TOTAL.toFixed(2)}</span>
        </div>
      </div>

      {state === "placed" ? (
        <div className="rounded-2xl border border-border bg-surface p-5 text-center shadow-sm">
          <div className="text-2xl">🌮</div>
          <div className="mt-1 font-semibold text-ink">Order placed</div>
          <p className="mt-1 text-sm text-muted">
            Charged to Maple Debit ·· 4471. Your dasher is on the way.
          </p>
        </div>
      ) : (
        <button
          onClick={placeOrder}
          disabled={state === "placing"}
          className="w-full rounded-xl bg-ink py-3 text-center text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
        >
          {state === "placing" ? "Placing order…" : `Place order · $${TOTAL.toFixed(2)}`}
        </button>
      )}
    </div>
  )
}
