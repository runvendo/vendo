import { useId } from "react"
import { cn } from "@/lib/cn"

/**
 * Cadence geometric mark: a decaying pulse — four bars falling into rhythm —
 * set in an evergreen tile. Also mirrored in src/app/icon.svg (favicon).
 */
export function CadenceMark({ size = 28, className }: { size?: number; className?: string }) {
  const gradientId = useId()
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Cadence"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#266755" />
          <stop offset="1" stopColor="#0b211c" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gradientId})`} />
      <rect x="6.4" y="11" width="3.2" height="10" rx="1.6" fill="#85bda8" />
      <rect x="12" y="7" width="3.2" height="18" rx="1.6" fill="#ffffff" />
      <rect x="17.6" y="9.5" width="3.2" height="13" rx="1.6" fill="#ffffff" opacity="0.85" />
      <rect x="23.2" y="12.5" width="3.2" height="7" rx="1.6" fill="#ffffff" opacity="0.6" />
    </svg>
  )
}

/** Full lockup: mark + wordmark. `tone` matches light chrome or the dark sidebar. */
export function CadenceLogo({
  tone = "dark",
  className,
}: {
  tone?: "dark" | "light"
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <CadenceMark size={28} />
      <span
        className={cn(
          "text-[17px] font-semibold tracking-tight",
          tone === "light" ? "text-white" : "text-ink",
        )}
      >
        Cadence
      </span>
    </span>
  )
}
