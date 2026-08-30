"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import clsx from "clsx"
import { money } from "@/lib/format"
import type { OrderStatus } from "@/server/types"

/**
 * Every write in this panel goes through Crate's own REST API rather than a
 * server action — the same routes the Vendo agent will call once `vendo init`
 * has extracted them. If a button here works, the agent's tool works.
 */
export function OrderActions({
  orderNumber,
  status,
  refundableCents,
}: {
  orderNumber: string
  status: OrderStatus
  refundableCents: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refundOpen, setRefundOpen] = useState(false)
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("duplicate")

  const working = busy || pending

  async function call(path: string, body: Record<string, unknown> = {}) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        // The domain writes its rejections to be read by a person, so show the
        // message rather than a status code.
        setError(payload?.error?.message ?? `Request failed (${res.status}).`)
        return false
      }
      setRefundOpen(false)
      startTransition(() => router.refresh())
      return true
    } catch {
      setError("Could not reach the server.")
      return false
    } finally {
      setBusy(false)
    }
  }

  const canFulfil = status === "paid"
  const canShip = status === "paid" || status === "fulfilled"
  const canCancel = status === "pending" || status === "paid" || status === "fulfilled"
  const canRefund = refundableCents > 0 && status !== "pending" && status !== "cancelled"

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button disabled={!canFulfil || working} onClick={() => call(`/api/orders/${orderNumber}/fulfill`)}>
          Mark fulfilled
        </Button>
        <Button
          disabled={!canShip || working}
          onClick={() => call("/api/shipments", { order_id: orderNumber })}
        >
          Create shipment
        </Button>
        <Button
          disabled={!canCancel || working}
          onClick={() => call(`/api/orders/${orderNumber}/cancel`, { reason: "Cancelled from the console" })}
        >
          Cancel
        </Button>
        <Button
          tone="danger"
          disabled={!canRefund || working}
          onClick={() => setRefundOpen((open) => !open)}
        >
          Refund…
        </Button>
      </div>

      {refundOpen && (
        <div className="rounded-card border border-border bg-bg p-3">
          <p className="text-xs text-muted">
            {money(refundableCents)} is still refundable on {orderNumber}. Leave the amount blank to
            refund all of it.
          </p>
          <div className="mt-2.5 flex flex-wrap items-end gap-2">
            <label className="text-xs text-ink-soft">
              Amount
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder={(refundableCents / 100).toFixed(2)}
                className="nums mt-1 block w-28 rounded-md border border-border-strong bg-surface px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-ink-soft">
              Reason
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="mt-1 block rounded-md border border-border-strong bg-surface px-2 py-1.5 text-sm"
              >
                {["duplicate", "defective", "not_as_described", "late_delivery", "changed_mind", "other"].map(
                  (value) => (
                    <option key={value} value={value}>
                      {value.replace(/_/g, " ")}
                    </option>
                  ),
                )}
              </select>
            </label>
            <Button
              tone="danger"
              disabled={working}
              onClick={() =>
                call("/api/refunds", {
                  order_id: orderNumber,
                  reason,
                  // Dollars in the box, cents on the wire. Math.round keeps
                  // 48.15 from arriving as 4814.999999999999.
                  ...(amount.trim() ? { amount_cents: Math.round(Number(amount) * 100) } : {}),
                })
              }
            >
              {working ? "Refunding…" : "Refund"}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="rounded-md bg-neg-bg px-3 py-2 text-sm text-neg" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function Button({
  children,
  onClick,
  disabled,
  tone = "default",
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: "default" | "danger"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "rounded-md border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        tone === "danger"
          ? "border-neg/30 text-neg hover:bg-neg-bg"
          : "border-border-strong text-ink-soft hover:bg-hover",
      )}
    >
      {children}
    </button>
  )
}
