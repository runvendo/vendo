// Client-side API access. Every Cadence endpoint wraps its payload in a
// `{ data }` envelope (see src/server/http.ts); the fetcher unwraps it so SWR
// hooks work directly with domain shapes.

import type { ClientSummary, DeadlineEntry } from "@/server/clients"
import type { DashboardMetrics } from "@/server/documents"
import type { ActivityEvent, DocumentRequest, Message } from "@/server/types"

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const json = (await res.json().catch(() => null)) as
    | { data?: T; error?: { message?: string } }
    | null
  if (!res.ok) {
    throw new ApiError(json?.error?.message ?? `Request failed: ${url}`, res.status)
  }
  if (json === null || !("data" in json)) {
    throw new ApiError(`Malformed response (missing data envelope): ${url}`, res.status)
  }
  return json.data as T
}

/** Shape of GET /api/dashboard (and POST /api/demo/reset): the full server metrics. */
export type DashboardData = DashboardMetrics

export type { ActivityEvent, ClientSummary, DeadlineEntry, DocumentRequest, Message }
