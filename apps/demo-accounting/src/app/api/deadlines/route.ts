import { parseInstant } from "@/server/asof"
import { listDeadlineEntries } from "@/server/clients"
import { ok } from "@/server/http"

export async function GET(req: Request) {
  // A snapshot read: `to` is the as-of instant, `from` is accepted but unused
  // (a filing calendar has no window — see the openapi description). Both are
  // declared so automation rehearsal pins the firing's time onto `to`.
  const to = parseInstant(new URL(req.url).searchParams.get("to"))
  return ok(listDeadlineEntries(to))
}
