import { cn } from "@/lib/cn"

/**
 * Cadence brand — a wordmark, not a mark: lowercase Manrope with the ledger
 * green full stop as the entire brand device. The favicon (src/app/icon.svg)
 * mirrors it as "c." on an ink tile.
 */
export function CadenceLogo({
  tone = "dark",
  size = 20,
  className,
}: {
  /** "dark" ink on light chrome; "light" white on dark surfaces. */
  tone?: "dark" | "light"
  size?: number
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline font-bold tracking-[-0.035em]",
        tone === "light" ? "text-white" : "text-ink",
        className,
      )}
      style={{ fontFamily: "var(--font-manrope), ui-sans-serif, system-ui", fontSize: size }}
    >
      cadence<span className="text-evergreen-500">.</span>
    </span>
  )
}
