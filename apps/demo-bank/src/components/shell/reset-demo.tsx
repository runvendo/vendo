"use client"
import { useState } from "react"
import { RotateCcw } from "lucide-react"

/** Wipes Vendo's client-side fire-once flags (greeting, whisper) so a reset
 *  demo greets like a first run. */
function clearVendoLocalState() {
  try {
    const doomed: string[] = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (key?.startsWith("vendo:")) doomed.push(key)
    }
    doomed.forEach((key) => window.localStorage.removeItem(key))
  } catch {
    // Storage unavailable — the server-side reset still ran.
  }
}

/** The visible demo panic button: reseeds Maple's fake bank data AND erases
 *  the demo subjects' Vendo state (threads, generated apps, pins, grants), so
 *  slots and conversations return to the out-of-the-box demo. ⌘⇧. does the
 *  same via the hotkey in VendoLayer. */
export function ResetDemoButton() {
  const [busy, setBusy] = useState(false)
  const reset = async () => {
    if (busy) return
    if (!window.confirm("Reset the demo? This clears conversations, generated apps, and pinned views.")) return
    setBusy(true)
    try {
      await fetch("/api/demo/reset", { method: "POST" })
    } finally {
      clearVendoLocalState()
      window.location.href = "/"
    }
  }
  return (
    <button
      type="button"
      onClick={() => void reset()}
      disabled={busy}
      title="Reset demo"
      className="flex w-full items-center justify-center gap-3 rounded-lg px-2.5 py-2 text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50 lg:justify-start"
    >
      <RotateCcw className="h-4 w-4 shrink-0" />
      <span className="hidden lg:inline">{busy ? "Resetting…" : "Reset demo"}</span>
    </button>
  )
}
