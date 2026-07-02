"use client"

import useSWR from "swr"
import { Avatar } from "@/components/clients/meta"
import { Card } from "@/components/ui/card"
import { PageHeader } from "@/components/ui/page-header"
import { Reveal } from "@/components/ui/reveal"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher, type ClientSummary } from "@/lib/api"

// The Hartwell & Associates roster, matching the seeded staff (src/server/seed.ts).
const TEAM = [
  { id: "st_daniel", name: "Daniel Hartwell", role: "Partner", initials: "DH" },
  { id: "st_maya", name: "Maya Alvarez", role: "Account Manager", initials: "MA" },
  { id: "st_priya", name: "Priya Natarajan", role: "Senior Accountant", initials: "PN" },
  { id: "st_tomas", name: "Tomas Okafor", role: "Bookkeeper", initials: "TO" },
] as const

function StaffCard({
  member,
  clients,
  failed,
}: {
  member: (typeof TEAM)[number]
  clients: ClientSummary[] | undefined
  failed: boolean
}) {
  const assigned = clients?.filter(c => c.assignee?.id === member.id)
  const chasing = assigned?.filter(c => c.status === "missing_docs").length ?? 0
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3.5">
        <Avatar initials={member.initials} className="h-11 w-11 text-[14px]" />
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold tracking-tight">{member.name}</p>
          <p className="mt-0.5 text-[12px] text-ink-soft">{member.role}</p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-line/70 pt-3.5 text-[12px]">
        {failed ? (
          <span className="text-ink-faint">Assignments unavailable</span>
        ) : assigned ? (
          <>
            <span className="text-ink-soft tabular-nums">
              {assigned.length} {assigned.length === 1 ? "client" : "clients"}
            </span>
            <span
              className={
                chasing > 0 ? "font-medium text-status-missing tabular-nums" : "text-ink-faint"
              }
            >
              {chasing > 0 ? `${chasing} missing docs` : "All caught up"}
            </span>
          </>
        ) : (
          <>
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-3.5 w-24" />
          </>
        )}
      </div>
    </Card>
  )
}

export default function TeamPage() {
  // Counts stay live: assignments come from the same client list the rest of the app reads.
  const { data, error } = useSWR<ClientSummary[]>("/api/clients", fetcher)

  return (
    <div className="space-y-6">
      <Reveal delay={0}>
        <PageHeader
          title="Team"
          description="Hartwell & Associates staff and their client assignments this season"
        />
      </Reveal>
      <Reveal delay={0.05}>
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {TEAM.map(member => (
            <StaffCard key={member.id} member={member} clients={data} failed={Boolean(error)} />
          ))}
        </div>
      </Reveal>
      <Reveal delay={0.1}>
        <p className="text-[12px] text-ink-faint">
          Client assignments are managed from each client&apos;s detail page.
        </p>
      </Reveal>
    </div>
  )
}
