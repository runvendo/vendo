import { ok } from "@/server/http"
import { getStore } from "@/server/store"

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("limit")
  const limit = raw == null ? undefined : Number(raw)
  const events = getStore().activity
  return ok(limit !== undefined && Number.isFinite(limit) && limit > 0 ? events.slice(0, limit) : events)
}
