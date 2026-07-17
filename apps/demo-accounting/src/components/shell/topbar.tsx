"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Bell, Search } from "lucide-react"

export interface TopbarUser {
  display: string
  avatarUrl?: string
}

function initials(display: string): string {
  return display
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0])
    .join("")
    .toUpperCase()
}

/** Signed-in chrome: global search, firm context, the session user's persona chip. */
export function Topbar({ user }: { user?: TopbarUser }) {
  const display = user?.display ?? "Maya Alvarez"
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // Global search lands on the client list, pre-filtered (the table reads ?q=).
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const q = inputRef.current?.value.trim() ?? ""
    router.push(q ? `/clients?q=${encodeURIComponent(q)}` : "/clients")
  }

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-line bg-card/90 px-6 backdrop-blur-sm">
      <form className="relative w-80 max-w-full" onSubmit={onSubmit} role="search">
        <Search
          size={14}
          strokeWidth={1.75}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint"
        />
        <input
          ref={inputRef}
          type="search"
          name="q"
          placeholder="Search clients, documents…"
          aria-label="Search"
          className="h-8 w-full rounded-lg border border-line bg-surface pr-12 pl-8 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:bg-card focus:ring-2 focus:ring-line focus:outline-none"
        />
        <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-line bg-card px-1.5 py-px font-sans text-[10px] text-ink-faint">
          &#8984;K
        </kbd>
      </form>
      <div className="ml-auto flex items-center gap-3">
        <span className="text-[13px] font-medium text-ink-soft">Hartwell &amp; Associates</span>
        <span className="h-4 w-px bg-line-strong" aria-hidden />
        <button
          type="button"
          aria-label="Notifications"
          className="relative flex h-8 w-8 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-surface hover:text-ink"
        >
          <Bell size={16} strokeWidth={1.75} />
          <span
            className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-status-missing ring-2 ring-card"
            aria-hidden
          />
        </button>
        <button
          type="button"
          className="flex items-center gap-2 rounded-full border border-line py-1 pr-3 pl-1 transition-colors hover:bg-surface"
        >
          {user?.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.avatarUrl}
              alt=""
              className="h-6 w-6 rounded-full object-cover"
            />
          ) : (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[10px] font-semibold text-white">
              {initials(display)}
            </span>
          )}
          <span className="text-[13px] font-medium">{display}</span>
        </button>
      </div>
    </header>
  )
}
