import { MapPin } from "lucide-react"

export function StaticMap({ location }: { location: string }) {
  return (
    <div className="relative h-44 w-full overflow-hidden rounded-card border border-border bg-hover">
      <svg
        className="absolute inset-0 h-full w-full text-border-strong"
        aria-hidden
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 400 180"
      >
        <defs>
          <pattern id="map-grid" width="32" height="32" patternUnits="userSpaceOnUse">
            <path d="M32 0H0V32" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" />
          </pattern>
        </defs>
        <rect width="400" height="180" fill="url(#map-grid)" />
        {/* A couple of "streets" for subtle realism */}
        <path d="M-20 132 L300 40" stroke="currentColor" strokeWidth="6" opacity="0.35" fill="none" />
        <path d="M60 -20 L240 200" stroke="currentColor" strokeWidth="4" opacity="0.3" fill="none" />
        <path d="M0 90 L420 110" stroke="currentColor" strokeWidth="3" opacity="0.25" fill="none" />
      </svg>

      {/* subtle vignette to lift the pin */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/[0.04] to-transparent" aria-hidden />

      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-white shadow-md">
          <MapPin className="h-4 w-4" />
        </div>
        <div className="absolute left-1/2 top-full mt-1 h-2 w-2 -translate-x-1/2 rounded-full bg-ink/15 blur-[2px]" />
      </div>

      <div className="absolute bottom-3 left-3 rounded-lg border border-border bg-surface/90 px-2.5 py-1 text-xs font-medium text-ink shadow-sm backdrop-blur">
        {location}
      </div>
    </div>
  )
}
