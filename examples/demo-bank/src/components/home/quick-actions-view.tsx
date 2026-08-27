"use client"
import type { ReactNode } from "react"

/**
 * The presentational quick-actions strip, remixable by Vendo (06-apps §8).
 *
 * Deliberately self-contained — React only — because a fork's module space is
 * React plus captured sub-sources: the lucide icons are inlined as SVG markup
 * and the Tailwind class names are plain strings, so the captured source renders
 * sandboxed in the fork venue. The container (`quick-actions.tsx`) owns the
 * toast plumbing and passes `onAction` — a function prop that cannot cross the
 * fork boundary.
 */

// Lucide path data (lucide.dev, ISC), inlined so the captured source renders
// without the lucide-react module.
const ICONS: Record<string, ReactNode> = {
  send: (
    <>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </>
  ),
  request: (
    <>
      <path d="M12 15V3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
    </>
  ),
  move: (
    <>
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </>
  ),
  bill: (
    <>
      <path d="M12 17V7" />
      <path d="M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8" />
      <path d="M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z" />
    </>
  ),
  deposit: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12h8" />
      <path d="M12 8v8" />
    </>
  ),
}

const DEFAULT_ACTIONS = [
  { label: "Send", icon: "send" },
  { label: "Request", icon: "request" },
  { label: "Move money", icon: "move" },
  { label: "Pay bill", icon: "bill" },
  { label: "Deposit", icon: "deposit" },
]

export interface QuickActionsViewProps {
  actions?: Array<{ label: string; icon?: string }>
  /** Host-side action wiring; a fork never receives it (functions do not
   *  cross the fork boundary) — its buttons are presentational until the
   *  remix rewires behavior through the host's API. */
  onAction?: (label: string) => void
}

export function QuickActionsView({ actions = DEFAULT_ACTIONS, onAction }: QuickActionsViewProps) {
  return (
    <div className="bg-surface border border-border rounded-card grid grid-cols-5 divide-x divide-border">
      {actions.map(({ label, icon }) => (
        <button
          key={label}
          type="button"
          onClick={() => onAction?.(label)}
          className="flex flex-col items-center justify-center gap-2 py-5 transition-colors hover:bg-hover first:rounded-l-card last:rounded-r-card"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-hover text-ink">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width={18}
              height={18}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {ICONS[icon ?? ""] ?? null}
            </svg>
          </span>
          <span className="text-[13px] font-medium text-ink">{label}</span>
        </button>
      ))}
    </div>
  )
}

// <Remixable> derives its remix slot from this identity at runtime, and the
// production bundle minifies the function name away — displayName is the
// React-canonical identity that survives, matching the exported identifier
// sync captures the baseline under.
QuickActionsView.displayName = "QuickActionsView"

// The fork's module loader renders a DEFAULT export (08-ui §5), so a
// remixable component must carry one; the named export stays for host imports.
export default QuickActionsView
