"use client"
import { useEffect, useMemo, useRef, useState } from "react"

/**
 * The presentational net-worth card, remixable by Vendo (06-apps §8).
 *
 * Deliberately self-contained — React only, inline styles, hand-rolled SVG —
 * so `vendo sync` static capture reproduces it faithfully inside the sandboxed
 * jail (whose module space is React plus captured sub-sources, and whose CSS is
 * the captured app-root stylesheet, not the compiled Tailwind bundle). The
 * container (`net-worth-card.tsx`) feeds it live data; the registration in
 * `src/vendo/host-components.tsx` feeds it seed-matching sampleProps.
 */

export type NetWorthRange = "1W" | "1M" | "3M" | "1Y" | "All"

const RANGE_OPTIONS: NetWorthRange[] = ["1W", "1M", "3M", "1Y", "All"]
const TAIL: Record<NetWorthRange, number> = {
  "1W": 4,
  "1M": 8,
  "3M": 18,
  "1Y": Number.POSITIVE_INFINITY,
  All: Number.POSITIVE_INFINITY,
}

// Maple brand values (globals.css @theme), inlined because captured source
// renders where the compiled Tailwind variables do not exist.
const INK = "#111111"
const MUTED = "#908C85"
const SURFACE = "#FFFFFF"
const BORDER = "#ECEBE8"
const HOVER = "#F4F3F1"
const POS = "#1E7F53"
const POS_BG = "#E7F4EE"
const FONT = 'var(--font-inter, system-ui), system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const formatCents = (cents: number) => usd.format(Math.abs(cents) / 100)

/** Minimal count-up (framer-motion-free so the jail can run it). */
function useCountUp(target: number): number {
  const [value, setValue] = useState(0)
  const frame = useRef(0)
  useEffect(() => {
    const reduced = typeof matchMedia === "function"
      && matchMedia("(prefers-reduced-motion: reduce)").matches
    const started = performance.now()
    const duration = reduced ? 0 : 600
    const tick = (now: number) => {
      const t = duration === 0 ? 1 : Math.min(1, (now - started) / duration)
      const eased = 1 - (1 - t) ** 3
      setValue(Math.round(target * eased))
      if (t < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [target])
  return value
}

/** Fritsch–Carlson monotone cubic — the same visual language as the previous
    recharts `type="monotone"` area, without the recharts dependency. */
function monotonePath(points: Array<readonly [number, number]>): string {
  if (points.length === 0) return ""
  if (points.length === 1) return `M${points[0]![0]},${points[0]![1]}`
  const n = points.length
  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const run = points[i + 1]![0] - points[i]![0] || 1e-6
    dx.push(run)
    slope.push((points[i + 1]![1] - points[i]![1]) / run)
  }
  const m: number[] = [slope[0]!]
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1]! * slope[i]! <= 0) m.push(0)
    else {
      const w1 = 2 * dx[i]! + dx[i - 1]!
      const w2 = dx[i]! + 2 * dx[i - 1]!
      m.push((w1 + w2) / (w1 / slope[i - 1]! + w2 / slope[i]!))
    }
  }
  m.push(slope[n - 2]!)
  let path = `M${points[0]![0]},${points[0]![1]}`
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!
    const [x1, y1] = points[i + 1]!
    const third = (x1 - x0) / 3
    path += `C${x0 + third},${y0 + m[i]! * third} ${x1 - third},${y1 - m[i + 1]! * third} ${x1},${y1}`
  }
  return path
}

function AreaChart({ series, height }: { series: number[]; height: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const width = 640 // viewBox space; the svg scales to its container
  const pad = 6
  const points = useMemo(() => {
    if (series.length === 0) return []
    const min = Math.min(...series)
    const max = Math.max(...series)
    const span = max - min || 1
    const stepX = series.length > 1 ? width / (series.length - 1) : 0
    return series.map((v, i) => [i * stepX, pad + (1 - (v - min) / span) * (height - pad * 2)] as const)
  }, [series, height])
  if (points.length === 0) return null
  const line = monotonePath(points)
  const area = `${line}L${width},${height}L0,${height}Z`
  const active = hover === null ? null : points[hover]
  return (
    <div style={{ position: "relative", width: "100%" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        style={{ display: "block" }}
        aria-hidden
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          const x = ((event.clientX - box.left) / box.width) * width
          const step = series.length > 1 ? width / (series.length - 1) : width
          setHover(Math.max(0, Math.min(series.length - 1, Math.round(x / step))))
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="nw-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={INK} stopOpacity={0.1} />
            <stop offset="100%" stopColor={INK} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#nw-area-fill)" stroke="none" />
        <path d={line} fill="none" stroke={INK} strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
        {active ? (
          <g>
            <line x1={active[0]} y1={0} x2={active[0]} y2={height} stroke="#DFDDD8" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={active[0]} cy={active[1]} r={3} fill={INK} stroke={SURFACE} strokeWidth={2} />
          </g>
        ) : null}
      </svg>
      {hover !== null && active ? (
        <div
          style={{
            position: "absolute",
            left: `${Math.min(88, Math.max(4, (active[0] / width) * 100))}%`,
            top: Math.max(0, active[1] - 44),
            transform: "translateX(-50%)",
            background: SURFACE,
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            padding: "4px 10px",
            boxShadow: "0 1px 3px rgba(17,17,17,.06), 0 10px 28px -14px rgba(17,17,17,.12)",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: INK, fontVariantNumeric: "tabular-nums" }}>
            {formatCents(series[hover] ?? 0)}
          </span>
        </div>
      ) : null}
    </div>
  )
}

export interface NetWorthViewProps {
  /** Total balance in integer cents. */
  valueCents: number
  /** Full net-worth history; the range control slices it locally. */
  series: number[]
  changeLabel?: string
  initialRange?: NetWorthRange
  chartHeight?: number
}

export function NetWorthView({
  valueCents,
  series,
  changeLabel = "▲ 2.3% this month",
  initialRange = "3M",
  chartHeight = 220,
}: NetWorthViewProps) {
  const [range, setRange] = useState<NetWorthRange>(initialRange)
  const animated = useCountUp(valueCents)
  const tail = TAIL[range]
  const sliced = tail === Number.POSITIVE_INFINITY ? series : series.slice(-tail)
  return (
    <article
      data-maple-net-worth
      style={{
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: 14,
        padding: "20px 20px 20px",
        fontFamily: FONT,
        color: INK,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: MUTED,
              fontWeight: 600,
            }}
          >
            Total balance
          </div>
          <span
            style={{
              display: "block",
              marginTop: 4,
              fontSize: 36,
              lineHeight: "40px",
              fontWeight: 600,
              letterSpacing: "-0.025em",
              fontVariantNumeric: "tabular-nums",
              color: INK,
            }}
          >
            {formatCents(animated)}
          </span>
          <div style={{ marginTop: 8 }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                borderRadius: 9999,
                padding: "2px 8px",
                fontSize: 12,
                lineHeight: "16px",
                fontWeight: 500,
                background: POS_BG,
                color: POS,
              }}
            >
              {changeLabel}
            </span>
          </div>
        </div>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            borderRadius: 8,
            background: HOVER,
            padding: 2,
          }}
        >
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setRange(option)}
              style={{
                padding: "0 10px",
                height: 28,
                borderRadius: 6,
                border: 0,
                fontSize: 13,
                fontWeight: 500,
                fontFamily: "inherit",
                cursor: "pointer",
                background: range === option ? SURFACE : "transparent",
                color: range === option ? INK : MUTED,
                boxShadow: range === option ? "0 1px 2px 0 rgba(0,0,0,0.05)" : "none",
              }}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <AreaChart series={sliced} height={chartHeight} />
      </div>
    </article>
  )
}

// The jail's module loader renders a fork's DEFAULT export (08-ui §5), so a
// remixable component must carry one; the named export stays for host imports.
export default NetWorthView
