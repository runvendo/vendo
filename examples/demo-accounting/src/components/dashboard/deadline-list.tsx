"use client"

import Link from "next/link"
import { CalendarCheck2 } from "lucide-react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { Remixable } from "@vendoai/ui/chrome"
import { clientLogoSrc } from "@/components/clients/client-marks"
import { Card, CardHeader } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { VendoRoot } from "@/components/vendo/VendoRoot"
import { fetcher, type DeadlineEntry } from "@/lib/api"
import { BASE_PATH, withBasePath } from "@/lib/base-path"
import { cn } from "@/lib/cn"
import { entityLabel } from "@/lib/format"
import { DeadlineListView } from "./deadline-list-view"

/**
 * Container for the upcoming-deadlines card. Data fetching, logo resolution,
 * and SPA navigation live HERE, on the host side of the fork boundary; the
 * loaded card itself is the presentational `DeadlineListView`, review-kind
 * remixable (2026-08-02 final shape) because its navigation is wired through
 * a function prop a fork cannot carry — a remix shows the user nothing until
 * a host reviewer approves it, and the approved version then mounts natively
 * in the page.
 */
export function DeadlineList({ className }: { className?: string }) {
  const router = useRouter()
  const { data, error } = useSWR<DeadlineEntry[]>("/api/deadlines", fetcher)
  const entries = data?.slice(0, 5)

  if (error || !entries || entries.length === 0) {
    return (
      <Card className={cn("overflow-hidden", className)}>
        <CardHeader
          title="Upcoming deadlines"
          action={
            <Link
              href="/calendar"
              className="text-[12px] font-medium text-ink underline-offset-2 transition-colors hover:underline"
            >
              View calendar
            </Link>
          }
        />
        {error ? (
          <ErrorState title="Couldn't load deadlines" />
        ) : !entries ? (
          <div className="space-y-4 px-5 pt-1 pb-5">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-center gap-6">
                <div className="flex-1">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="mt-2 h-3 w-64" />
                </div>
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={CalendarCheck2}
            title="No upcoming deadlines"
            description="Filing deadlines will appear here as client engagements are added."
          />
        )}
      </Card>
    )
  }

  return (
    <div className={className}>
      {/* director={false} like the hero: the card's live-wire client must not
          wait on a director script (read-only surface). */}
      <VendoRoot director={false}>
        <Remixable review>
          <DeadlineListView
            // hrefs carry the base path: a fork never receives onNavigate
            // (functions do not cross), so its anchors must resolve on their
            // own under /cadence. The host callback strips the prefix back
            // off for the router (which re-adds it).
            rows={entries.map(entry => ({
              id: entry.id,
              href: withBasePath(`/clients/${entry.id}`),
              businessName: entry.businessName,
              entityLabel: entityLabel(entry.entityType),
              status: entry.status,
              missingDocKinds: entry.missingDocKinds,
              progress: entry.progress,
              filingDeadline: entry.filingDeadline,
              logoSrc: clientLogoSrc(entry.id),
            }))}
            calendarHref={withBasePath("/calendar")}
            onNavigate={href =>
              router.push(href.startsWith(BASE_PATH) ? href.slice(BASE_PATH.length) || "/" : href)
            }
          />
        </Remixable>
      </VendoRoot>
    </div>
  )
}
