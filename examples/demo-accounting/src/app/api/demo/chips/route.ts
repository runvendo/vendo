// GET /api/demo/chips — the signed-in user's "try this" chip manifest. The
// thread renders one chip per entry; an empty manifest (pre-generation still
// running, or a non-demo user) means no chip row at all.
import { ok } from "@/server/http"
import { resolveCadenceSession } from "@/server/session"
import { readChipManifest } from "@/vendo/chips"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const session = await resolveCadenceSession(request)
  if (session === null) return ok({ chips: [] })
  const chips = await readChipManifest(session.subject)
  return ok({ chips: chips.map(({ key, prompt }) => ({ key, prompt })) })
}
