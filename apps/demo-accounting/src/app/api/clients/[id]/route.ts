import { getClientSummary } from "@/server/clients"
import { notFound, ok } from "@/server/http"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const client = getClientSummary(id)
  return client ? ok(client) : notFound(`Unknown client: ${id}`)
}
