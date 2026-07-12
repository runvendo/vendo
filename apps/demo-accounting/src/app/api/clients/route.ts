import { listClientSummaries } from "@/server/clients"
import { ok } from "@/server/http"

export async function GET(req: Request) {
  const u = new URL(req.url)
  return ok(
    listClientSummaries({
      filter: u.searchParams.get("filter"),
      q: u.searchParams.get("q"),
    }),
  )
}
