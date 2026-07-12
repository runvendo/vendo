"use client"
import * as React from "react"

type Toast = { id: number; title: string; description?: string }
const ToastCtx = React.createContext<(t: Omit<Toast, "id">) => void>(() => {})
export const useToast = () => React.useContext(ToastCtx)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([])
  const push = React.useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.floor(Math.random() * 1000)
    setToasts((s) => [...s, { id, ...t }])
    setTimeout(() => setToasts((s) => s.filter((x) => x.id !== id)), 3000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="min-w-[260px] rounded-xl border border-border bg-surface px-4 py-3 shadow-lg">
            <div className="text-sm font-medium text-ink">{t.title}</div>
            {t.description && <div className="text-xs text-muted mt-0.5">{t.description}</div>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
