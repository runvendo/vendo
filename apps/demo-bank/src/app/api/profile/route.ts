import { getProfile } from "@/server/accounts"
import { ok } from "@/server/http"
import { resolveMapleSession } from "@/vendo/auth"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  // The financial seed is shared demo data, but the identity is the real
  // Auth.js session — the chrome shows who is actually signed in.
  const user = await resolveMapleSession(req)
  const profile = getProfile()
  return ok(user ? { ...profile, name: user.display, email: user.email } : profile)
}
