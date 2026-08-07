"use client"
import * as React from "react"
import { animate, motion, useMotionValue, useTransform, useReducedMotion } from "framer-motion"
import { formatUSD } from "@/lib/money"

export function CountUp({ valueCents, className }: { valueCents: number; className?: string }) {
  const target = Number.isFinite(valueCents) ? valueCents : 0
  const reduced = useReducedMotion()
  const motionValue = useMotionValue(0)
  const display = useTransform(motionValue, (v) => formatUSD(Math.round(v)))

  React.useEffect(() => {
    if (reduced) {
      motionValue.set(target)
      return
    }
    const controls = animate(motionValue, target, { duration: 0.6, ease: "easeOut" })
    return () => controls.stop()
  }, [target, reduced, motionValue])

  if (reduced) return <span className={className}>{formatUSD(target)}</span>

  return <motion.span className={className}>{display}</motion.span>
}
