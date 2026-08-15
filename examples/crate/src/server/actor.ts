import { clerkEnabled } from "./clerk-config"
import { primaryStaff, staffByEmail, staffForSubject } from "./staff"
import type { StaffUser } from "./types"

/**
 * Who is making this request. Every write records it, because "who refunded
 * $481" is the first question anyone asks afterwards.
 *
 * This is the identity seam, and it has exactly one job: turn whatever the auth
 * provider knows into a Crate staff member. Clerk answers "who signed in";
 * Crate's own roster answers "and are they staff here?". The same function is
 * behind `clerk({ user })` in the Vendo composition, so the agent and the
 * console can never disagree about who is acting.
 *
 * With Clerk unconfigured it returns the seeded owner, which is what makes a
 * fresh clone runnable — see clerk-config.ts.
 */
export async function resolveActor(req: Request): Promise<StaffUser | null> {
  // An unattended (away) run carries no session — it carries a verified away
  // token, which the proxy has already checked before setting this header and
  // strips outright when a caller tries to supply it themselves. So it is safe
  // to trust here, and only here.
  const awaySubject = req.headers.get("x-vendo-away-subject")
  if (awaySubject) return staffForSubject(awaySubject)

  if (!clerkEnabled) return primaryStaff()

  // Imported lazily: pulling @clerk/nextjs/server in at module scope would run
  // Clerk's request machinery on every route, including when it is switched off.
  const { currentUser } = await import("@clerk/nextjs/server")
  const user = await currentUser().catch(() => null)
  if (!user) return null

  const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress
  // Signed in to Clerk but not on Crate's roster is a real state, and it is not
  // an error — it is someone else's account. They are simply not staff here.
  return staffByEmail(email)
}

/** The actor, or the seeded owner. For reads, where "who" is not load-bearing. */
export async function resolveActorOrOwner(req: Request): Promise<StaffUser> {
  return (await resolveActor(req)) ?? primaryStaff()
}
