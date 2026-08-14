import { getStore } from "./store"
import type { StaffUser } from "./types"

/**
 * Who is making this request. Every write records it, because "who refunded
 * $481" is the first question anyone asks afterwards.
 *
 * ⚠️ This is the identity seam, and it is deliberately a stub: it returns the
 * seeded admin so the API is usable before auth exists. ENG-411 replaces the
 * body of this function with the real provider session (Clerk or Supabase) and
 * wires the same user through `createVendo`'s principal resolver — one seam,
 * one place to change.
 */
export async function resolveActor(_req: Request): Promise<StaffUser> {
  const store = getStore()
  return store.staff.find((u) => u.role === "admin") ?? store.staff[0]
}
