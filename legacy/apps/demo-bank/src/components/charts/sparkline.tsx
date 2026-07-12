"use client"

import { cn } from "@/lib/cn"

interface SparklineProps {
  data: number[]
  className?: string
  stroke?: string
  width?: number
  height?: number
}

/** Tiny hand-rolled SVG sparkline. No axes, no recharts. Scales to its container. */
export function Sparkline({
  data,
  className,
  stroke = "var(--color-ink)",
  width = 100,
  height = 28,
}: SparklineProps) {
  if (data.length === 0) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const stepX = data.length > 1 ? width / (data.length - 1) : 0
  const pad = 2 // keep the stroke off the top/bottom edges

  const points = data.map((v, i) => {
    const x = i * stepX
    const y = pad + (1 - (v - min) / span) * (height - pad * 2)
    return [x, y] as const
  })

  const line = points.map(([x, y]) => `${x},${y}`).join(" ")
  const area = `${line} ${width},${height} 0,${height}`

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={cn("block w-full", className)}
      aria-hidden
    >
      <polygon points={area} fill={stroke} fillOpacity={0.06} stroke="none" />
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
