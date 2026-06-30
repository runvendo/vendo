"use client"
import * as React from "react"
import { cn } from "@/lib/cn"
import { logoUrl } from "@/lib/logos"

export function BrandLogo({
  domain, alt, size = 36, rounded = "rounded-[10px]", className, fallback,
}: {
  domain?: string
  alt: string
  size?: number
  rounded?: string
  className?: string
  fallback: React.ReactNode
}) {
  const [errored, setErrored] = React.useState(false)
  if (!domain || errored) return <>{fallback}</>
  return (
    <div
      className={cn("shrink-0 overflow-hidden bg-white border border-border flex items-center justify-center", rounded, className)}
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={logoUrl(domain, 128)}
        alt={alt}
        onError={() => setErrored(true)}
        loading="lazy"
        style={{ width: Math.round(size * 0.66), height: Math.round(size * 0.66) }}
        className="object-contain"
      />
    </div>
  )
}
