"use client"

import { use } from "react"
import { ClientDetail } from "@/components/clients/client-detail"

export default function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <ClientDetail id={id} />
}
