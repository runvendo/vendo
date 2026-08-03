"use client"

import { useState } from "react"
import { daysUntil, formatDate } from "@/lib/format"

/**
 * The presentational upcoming-deadlines card, remixable by Vendo behind
 * review (06-apps §8, 2026-08-02 final shape).
 *
 * Deliberately self-contained — React plus the pure `@/lib/format` helpers —
 * because a fork's module space is React and captured sub-sources: the badge
 * and progress-bar markup is inlined (mirroring `ui/badge.tsx` and
 * `ui/progress.tsx`), the row arrow is inline SVG (lucide ArrowUpRight), and
 * class names are plain strings (review-kind forks mount natively in the page
 * on approval, where the compiled Tailwind bundle exists; they never render
 * in the jail). The container (`deadline-list.tsx`) owns data fetching, logo
 * resolution, and SPA navigation — `onNavigate` is a function prop that
 * cannot cross the fork boundary, which is exactly why this surface is
 * review-kind.
 */

// Status tints, mirroring BADGE_VARIANTS in ui/badge.tsx (inlined for capture).
const BADGE_CLASSES: Record<string, string> = {
  missing: "bg-status-missing-bg text-status-missing",
  overdue: "bg-status-overdue-bg text-status-overdue",
  neutral: "border border-line bg-surface text-ink-soft",
}

function urgency(days: number): { variant: string; label: string } {
  if (days < 0) return { variant: "overdue", label: `${-days}d overdue` }
  if (days === 0) return { variant: "overdue", label: "Due today" }
  if (days <= 21) return { variant: "missing", label: `in ${days} days` }
  return { variant: "neutral", label: `in ${days} days` }
}

function initials(name: string): string {
  return name
    .replace(/[^a-zA-Z ]/g, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0])
    .join("")
    .toUpperCase()
}

/** Client logo tile (mirrors ClientMark): the container resolves `logoSrc`;
 *  no source (or a broken image) falls back to an initials tile. */
function MarkTile({ name, logoSrc }: { name: string; logoSrc?: string }) {
  const [errored, setErrored] = useState(false)
  if (!logoSrc || errored) {
    return (
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center rounded-[9px] bg-line/60 text-ink-soft"
        style={{ width: 34, height: 34, fontSize: 11.56, fontWeight: 700 }}
      >
        {initials(name)}
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-[9px] border border-line bg-white"
      style={{ width: 34, height: 34 }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logoSrc} alt="" onError={() => setErrored(true)} loading="lazy" style={{ width: 21, height: 21 }} className="object-contain" />
    </span>
  )
}

export interface DeadlineListRow {
  id: string
  /** Host route for the client — the anchor href and the onNavigate payload. */
  href: string
  businessName: string
  /** Host-formatted entity label ("S-Corp", "Partnership", …). */
  entityLabel: string
  /** "missing_docs" | "in_review" | "complete" */
  status: string
  missingDocKinds: string[]
  progress: { received: number; total: number }
  /** ISO date. */
  filingDeadline: string
  /** Resolved logo URL; absent renders the initials tile. */
  logoSrc?: string
}

export interface DeadlineListViewProps {
  rows?: DeadlineListRow[]
  /** Host route for the calendar page (the header action). */
  calendarHref?: string
  /** Host-side SPA navigation; a fork never receives it (functions do not
   *  cross the fork boundary) — its links then navigate as plain anchors. */
  onNavigate?: (href: string) => void
}

export function DeadlineListView({ rows = [], calendarHref = "/calendar", onNavigate }: DeadlineListViewProps) {
  const go = (event: { preventDefault(): void }, href: string) => {
    if (!onNavigate) return // let the anchor navigate
    event.preventDefault()
    onNavigate(href)
  }
  return (
    <div className="rounded-xl border border-line bg-card shadow-card overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <h2 className="text-[13px] font-semibold tracking-tight">Upcoming deadlines</h2>
        <a
          href={calendarHref}
          onClick={event => go(event, calendarHref)}
          className="text-[12px] font-medium text-ink underline-offset-2 transition-colors hover:underline"
        >
          View calendar
        </a>
      </div>
      <ul className="divide-y divide-line/70 border-t border-line/70">
        {rows.map(row => {
          const days = daysUntil(row.filingDeadline)
          const badge = urgency(days)
          return (
            <li key={row.id}>
              <a
                href={row.href}
                onClick={event => go(event, row.href)}
                className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-surface/70"
              >
                <MarkTile name={row.businessName} logoSrc={row.logoSrc} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] font-medium">{row.businessName}</span>
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${BADGE_CLASSES.neutral}`}>
                      {row.entityLabel}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-[12px] text-ink-faint">
                    {row.missingDocKinds.length > 0 ? (
                      <>
                        <span className="font-medium text-status-missing">Missing:</span>{" "}
                        {row.missingDocKinds.join(", ")}
                      </>
                    ) : row.status === "in_review" ? (
                      "All documents in — awaiting review"
                    ) : (
                      "All documents verified"
                    )}
                  </p>
                </div>
                <div className="w-28 shrink-0">
                  <div className="flex items-center justify-between text-[11px] text-ink-faint tabular-nums">
                    <span>
                      {row.progress.received} of {row.progress.total}
                    </span>
                    <span>{formatDate(row.filingDeadline)}</span>
                  </div>
                  {/* Document-collection meter (mirrors ui/progress.tsx). */}
                  <div
                    role="progressbar"
                    aria-valuenow={row.progress.received}
                    aria-valuemin={0}
                    aria-valuemax={row.progress.total}
                    className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-line/80"
                  >
                    <div
                      className={`h-full rounded-full transition-[width] duration-500 ${
                        row.progress.received >= row.progress.total ? "bg-status-verified" : "bg-evergreen-500"
                      }`}
                      style={{
                        width: `${row.progress.total > 0 ? Math.min(100, Math.round((row.progress.received / row.progress.total) * 100)) : 0}%`,
                      }}
                    />
                  </div>
                </div>
                <span className={`inline-flex w-24 items-center justify-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap tabular-nums ${BADGE_CLASSES[badge.variant]}`}>
                  {badge.label}
                </span>
                {/* lucide ArrowUpRight (lucide.dev, ISC), inlined for capture. */}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width={14}
                  height={14}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                  className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <path d="M7 7h10v10" />
                  <path d="M7 17 17 7" />
                </svg>
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// <Remixable> derives its remix slot from this identity at runtime, and the
// production bundle minifies the function name away — displayName is the
// React-canonical identity that survives, matching the exported identifier
// sync captures the baseline under.
DeadlineListView.displayName = "DeadlineListView"

// The fork's module loader renders a DEFAULT export (08-ui §5), so a
// remixable component must carry one; the named export stays for host imports.
export default DeadlineListView
