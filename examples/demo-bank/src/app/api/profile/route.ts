import { getProfile } from "@/server/accounts"
import { isAutologinSession } from "@/server/autologin"
import { ok } from "@/server/http"
import { mapleDemoUsers } from "@/server/users"
import { resolveMapleSession } from "@/vendo/auth"

export const dynamic = "force-dynamic"

/** The avatar is part of the IDENTITY, not of the shared financial seed, so the
 *  initials are derived from the signed-in display name. Before this, the route
 *  replaced name and email but left the seed's initials, and the sidebar and the
 *  account switcher both read "YH" for whoever signed in. */
function initialsOf(display: string, fallback: string): string {
  const letters = display.trim().split(/\s+/).map((word) => word[0]).filter(Boolean)
  return letters.length === 0 ? fallback : letters.slice(0, 2).join("").toUpperCase()
}

export async function GET(req: Request) {
  // The financial seed is shared demo data, but the identity is the real
  // Auth.js session — the chrome shows who is actually signed in.
  const user = await resolveMapleSession(req)
  const profile = getProfile()
  // Undefined for credential logins (and dropped from the JSON): only an
  // auto-minted session (DEMO_AUTOLOGIN) shows the "Live demo" chip.
  const demoAutologin = (await isAutologinSession(req)) || undefined
  // The seeded roster (identity only — the password never leaves the server)
  // so the account switcher can offer the OTHER staff member. E8 needs two
  // real people in one org to prove sharing.
  const staff = mapleDemoUsers()
  return ok(
    user
      ? {
          ...profile,
          name: user.display,
          email: user.email,
          avatarInitials: initialsOf(user.display, profile.avatarInitials),
          demoAutologin,
          staff,
        }
      : { ...profile, demoAutologin, staff },
  )
}
