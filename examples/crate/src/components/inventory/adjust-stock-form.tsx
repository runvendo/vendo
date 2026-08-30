"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

/** Posts to the same route the agent's stock tool binds to. */
export function AdjustStockForm({ sku }: { sku: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [delta, setDelta] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const working = busy || pending

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(sku)}/adjust-stock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delta: Number(delta), reason }),
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok) {
        setError(payload?.error?.message ?? `Request failed (${res.status}).`)
        return
      }
      setDelta("")
      setReason("")
      startTransition(() => router.refresh())
    } catch {
      setError("Could not reach the server.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2.5 px-4 py-3.5">
      <div className="flex items-end gap-2">
        <label className="text-xs text-ink-soft">
          Units
          <input
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            inputMode="numeric"
            placeholder="+12"
            className="nums mt-1 block w-20 rounded-md border border-border-strong bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex-1 text-xs text-ink-soft">
          Reason
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="PO-4417 received"
            className="mt-1 block w-full rounded-md border border-border-strong bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={working}
          className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-hover disabled:opacity-40"
        >
          {working ? "Saving…" : "Adjust"}
        </button>
      </div>
      <p className="text-xs text-muted">Negative numbers remove stock. The reason is required.</p>
      {error && (
        <p className="rounded-md bg-neg-bg px-3 py-2 text-sm text-neg" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
