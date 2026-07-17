"use client"

import * as React from "react"
import { cn } from "@/lib/cn"
import { logoUrl } from "@/lib/logos"

/**
 * Client logo tiles: the firm's clients are recognizable real companies, so
 * each tile renders the real logo via the shared favicon mechanism (same as
 * Maple's merchant rows). Individuals get initials tiles — real software does
 * not invent logos for people — and any client without a clean favicon falls
 * back the same way. Keyed by the deterministic seed ids.
 *
 * Values starting with "/" are bundled assets in public/ — used when the
 * favicon service only has a low-res icon (Blue Bottle's is 16px).
 */
const DOMAINS: Record<string, string> = {
  cl_rivera: "/logos/bluebottle.png",
  cl_chen: "linear.app",
  cl_delgado: "sweetgreen.com",
  cl_harborview: "equinox.com",
  cl_foster: "taskrabbit.com",
  cl_kim: "compass.com",
  cl_cortez: "jiffylube.com",
  cl_lakeside: "banfield.com",
  cl_whitfield: "figma.com",
  cl_mercer: "legalzoom.com",
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

function InitialsTile({
  name,
  size,
  className,
}: {
  name: string
  size: number
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[9px] bg-line/60 text-ink-soft",
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.34, fontWeight: 700 }}
    >
      {initials(name)}
    </span>
  )
}

export function ClientMark({
  clientId,
  name,
  size = 34,
  className,
}: {
  clientId: string
  name: string
  size?: number
  className?: string
}) {
  const domain = DOMAINS[clientId]
  const [errored, setErrored] = React.useState(false)
  if (!domain || errored) return <InitialsTile name={name} size={size} className={className} />
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-[9px] border border-line bg-white",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={domain.startsWith("/") ? domain : logoUrl(domain, 128)}
        alt=""
        onError={() => setErrored(true)}
        loading="lazy"
        style={{ width: Math.round(size * 0.62), height: Math.round(size * 0.62) }}
        className="object-contain"
      />
    </span>
  )
}
