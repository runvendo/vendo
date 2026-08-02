import { getProfile } from "@/server/accounts"
import { isAutologinSession } from "@/server/autologin"
import { ok } from "@/server/http"
import { resolveMapleSession } from "@/vendo/auth"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  // The financial seed is shared demo data, but the identity is the real
  // Auth.js session — the chrome shows who is actually signed in.
  const user = await resolveMapleSession(req)
  const profile = getProfile()
  // Undefined for credential logins (and dropped from the JSON): only an
  // auto-minted session (DEMO_AUTOLOGIN) shows the "Live demo" chip.
  const demoAutologin = (await isAutologinSession(req)) || undefined
  return ok(
    user
      ? { ...profile, name: user.display, email: user.email, demoAutologin }
      : { ...profile, demoAutologin },
  )
}
