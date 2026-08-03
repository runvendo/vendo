"use client";

import { useEffect, useState, type ReactNode } from "react";

// ============================================================================
// PLUMBING — DO NOT REWRITE PER PROSPECT.
// The persistent demo framing every generated demo keeps: the
// "[Prospect] demo · built with Vendo · sample data" badge, the
// "Get this in your product" CTA, and the friendly card shown when the caps
// guard refuses (limit reached / expired). Creator agents restyle via theme
// tokens (globals.css) and rewrite the product surface elsewhere under
// src/app — they must not remove this chrome, its copy, or the status polling
// that swaps in the limit card.
// ============================================================================

/** The `vendoDemo` body the caps guard refuses with (see src/server/caps.ts). */
export interface DemoChromeRefusal {
  limit: "turns" | "spend" | "expired";
  message: string;
  ctaUrl: string;
}

/**
 * How often the live chrome re-checks GET /demo-status. The caps guard is
 * server-side, so a mid-session refusal only surfaces inside the thread as a
 * failed request ("Something went wrong / Retry"); polling promotes it to the
 * friendly card within one tick. Cheap: the endpoint is a counters-file read.
 */
const STATUS_POLL_MS = 8000;

function LimitCard({ refusal, fallbackCtaUrl }: { refusal: DemoChromeRefusal; fallbackCtaUrl: string }) {
  return (
    <div className="w-full max-w-md rounded-xl border bg-surface p-8 text-center shadow-sm">
      <h2 className="text-lg font-semibold tracking-tight text-ink">
        {refusal.limit === "expired" ? "This demo has expired" : "This demo has reached its limit"}
      </h2>
      <p className="mt-2 text-sm text-muted">{refusal.message}</p>
      <a
        href={refusal.ctaUrl || fallbackCtaUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-6 inline-block rounded-full bg-ink px-5 py-2 text-sm font-medium text-surface"
      >
        Book a call
      </a>
    </div>
  );
}

/**
 * Wraps the demo surface: badge + CTA header always; children while the demo
 * is live; the limit/expired card once the caps guard refuses.
 * `initialRefusal` is the server-rendered status at page load — when it's
 * already refused there's nothing to show, so the card REPLACES the surface.
 * After mount the status endpoint is polled; a mid-session refusal instead
 * shows the card ABOVE the still-mounted thread, so the final allowed turn's
 * answer (which may still be streaming when the cap trips) stays readable.
 */
export function DemoChrome(props: {
  prospect: string;
  ctaUrl: string;
  initialRefusal?: DemoChromeRefusal | null;
  children: ReactNode;
}) {
  const { prospect, ctaUrl, initialRefusal = null, children } = props;
  const [refusal, setRefusal] = useState<DemoChromeRefusal | null>(initialRefusal);

  useEffect(() => {
    if (refusal !== null) return; // caps never un-trip without a counter reset
    let active = true;
    const check = async () => {
      try {
        const response = await fetch("/demo-status", { cache: "no-store" });
        const body = (await response.json()) as { vendoDemo?: DemoChromeRefusal | null };
        if (active && body.vendoDemo != null) setRefusal(body.vendoDemo);
      } catch {
        // Transient fetch failure — stay live; the next tick retries.
      }
    };
    const timer = setInterval(() => void check(), STATUS_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refusal]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b bg-surface px-4 py-2">
        <span className="text-xs text-muted">
          <span className="font-medium text-ink">{prospect} demo</span> · built with Vendo · sample
          data
        </span>
        <a
          href={ctaUrl}
          target="_blank"
          rel="noreferrer"
          className="rounded-full border px-3 py-1 text-xs font-medium text-ink transition-colors hover:bg-bg"
        >
          Get this in your product
        </a>
      </header>
      {refusal !== null ? (
        <section
          role="status"
          aria-label="Demo unavailable"
          className={
            initialRefusal !== null
              ? "flex min-h-0 flex-1 items-center justify-center p-8"
              : "flex justify-center border-b bg-bg p-4"
          }
        >
          <LimitCard refusal={refusal} fallbackCtaUrl={ctaUrl} />
        </section>
      ) : null}
      {/* The surface stays mounted at THIS tree position when a mid-session
          refusal adds the card above it — moving it would remount VendoThread
          and wipe the visible conversation. It renders null only when the
          page loaded already-refused (nothing to preserve). */}
      {refusal === null || initialRefusal === null ? children : null}
    </div>
  );
}
