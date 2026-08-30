import { clerkEnabled } from "./clerk-config"
import { getStore } from "./store"
import type { StaffUser } from "./types"

/**
 * Crate's own roster, and the only thing that decides who may use Crate.
 *
 * Clerk answers "who signed in"; this answers "and are they staff here?" —
 * the split every identity preset assumes. Clerk hands back a subject
 * (`user_2abc…`) that means nothing to Crate, so the join is on **email**: it
 * is the one claim both sides already agree on, and it means the roster below
 * keeps working no matter which Clerk instance the app is pointed at.
 */
export function staffByEmail(email: string | undefined | null): StaffUser | null {
  if (!email) return null
  const key = email.trim().toLowerCase()
  return getStore().staff.find((u) => u.email.toLowerCase() === key) ?? null
}

/**
 * Subject → staff, which is what every Vendo seam actually gets handed.
 *
 * A `Principal` carries a subject and nothing else — no email — and a Clerk
 * subject (`user_2abc…`) is opaque to Crate. Clerk's default session claims do
 * not carry an email either, so the join has to go and ask: one lookup against
 * Clerk's backend API, memoized, since a subject's email does not change
 * mid-process. The roster's own `subject` values are checked first so a seeded
 * or self-hosted subject keeps working without any network call at all.
 */
const subjectEmails = new Map<string, string | null>()

export async function staffForSubject(subject: string): Promise<StaffUser | null> {
  const roster = getStore().staff.find((u) => u.subject === subject)
  if (roster) return roster

  // An email that arrived as the subject (some seams pass one) still resolves.
  const direct = staffByEmail(subject)
  if (direct) return direct

  // Only Clerk can turn an opaque `user_2abc…` into an email, so with Clerk off
  // a subject that matched neither the roster nor an email is simply unknown.
  if (!clerkEnabled) return null

  if (!subjectEmails.has(subject)) {
    subjectEmails.set(subject, await clerkEmailFor(subject))
  }
  return staffByEmail(subjectEmails.get(subject) ?? null)
}

async function clerkEmailFor(subject: string): Promise<string | null> {
  try {
    const { createClerkClient } = await import("@clerk/backend")
    const client = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! })
    const user = await client.users.getUser(subject)
    return user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null
  } catch {
    // Unknown subject, revoked user, or Clerk unreachable. Not staff, and the
    // caller treats that as "signed in elsewhere" rather than as an error.
    return null
  }
}

/** The seeded owner. Used as the actor whenever Clerk is not configured. */
export function primaryStaff(): StaffUser {
  const store = getStore()
  return store.staff.find((u) => u.role === "admin") ?? store.staff[0]
}

/** Name, email, or the id printed in the console — whatever someone typed. */
export function findStaff(query: string): StaffUser | null {
  const key = query.trim().toLowerCase()
  if (!key) return null
  return (
    getStore().staff.find(
      (u) =>
        u.id.toLowerCase() === key ||
        u.email.toLowerCase() === key ||
        u.display.toLowerCase() === key ||
        u.display.toLowerCase().startsWith(key),
    ) ?? null
  )
}

/**
 * The [User] block: what the agent is told about whoever is signed in,
 * asserted fresh on every request. Data only, never instructions — and only
 * what a support agent legitimately needs to do the job.
 */
export function staffFacts(user: StaffUser) {
  return {
    name: user.display,
    email: user.email,
    role: user.role === "admin" ? "shop owner" : "support agent",
    // Said out loud because the agent should not have to infer it from a 403:
    // only an owner may hand money back.
    canRefund: user.role === "admin" ? "yes" : "no — an owner has to approve refunds",
  }
}
