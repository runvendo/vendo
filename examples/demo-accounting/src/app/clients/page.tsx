"use client"

import { Suspense } from "react"
import { ClientTable, ClientTableSkeleton } from "@/components/clients/client-table"
import { PageHeader } from "@/components/ui/page-header"
import { Reveal } from "@/components/ui/reveal"

export default function ClientsPage() {
  return (
    <div className="space-y-6">
      <Reveal delay={0}>
        <PageHeader
          title="Clients"
          description="Every engagement at Hartwell & Associates, with document status at a glance"
        />
      </Reveal>
      <Reveal delay={0.05}>
        {/* ClientTable reads ?q= via useSearchParams, which requires a Suspense boundary. */}
        <Suspense fallback={<ClientTableSkeleton />}>
          <ClientTable />
        </Suspense>
      </Reveal>
    </div>
  )
}
