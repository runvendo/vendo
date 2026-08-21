/**
 * POST /api/demo/reset — puts the seeded store back, including the duplicate
 * charge, after someone has refunded their way through the demo.
 *
 * Restricted to the demo's own origin: it discards every write made since the
 * process started, and that is not something a link someone clicks should be
 * able to do.
 */
import { __reseed } from "@/server/store"
import { ok } from "@/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin")
  if (!origin) return true // same-origin fetches and server-side calls send none
  try {
    return new URL(origin).host === new URL(req.url).host
  } catch {
    return false
  }
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) {
    return Response.json(
      { error: { message: "reset is restricted to the demo's own origin", code: "forbidden" } },
      { status: 403 },
    )
  }
  const seed = __reseed(new Date())
  return ok({ reset: true, story: seed.story })
}
