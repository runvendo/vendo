import { parseInstant } from "@/server/asof"
import { ok } from "@/server/http"
import { getStore } from "@/server/store"

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams
  const raw = params.get("limit")
  const limit = raw == null ? undefined : Number(raw)
  // Every event carries a real `at`, so a window here is an exact filter —
  // no projection involved (contrast ./asof, which can only roll back uploads).
  const from = parseInstant(params.get("from"))
  const to = parseInstant(params.get("to"))
  const events = getStore().activity.filter(event => {
    const at = new Date(event.at).getTime()
    if (Number.isNaN(at)) return true
    return (from === undefined || at >= from.getTime())
      && (to === undefined || at <= to.getTime())
  })
  return ok(limit !== undefined && Number.isFinite(limit) && limit > 0 ? events.slice(0, limit) : events)
}
