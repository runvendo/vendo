/**
 * Whether Clerk is actually configured on this machine.
 *
 * Crate has to run before anyone has a Clerk account — `pnpm dev` on a fresh
 * clone must show the shop, not a stack trace about a missing publishable key.
 * So every Clerk touchpoint (middleware, provider, session read) is behind this
 * flag, and with it false Crate acts as the seeded owner.
 *
 * Both keys are required together on purpose: a publishable key with no secret
 * key renders a sign-in box that can never verify a session, which fails later
 * and further away than simply staying off.
 */
export const clerkEnabled: boolean =
  Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) && Boolean(process.env.CLERK_SECRET_KEY)
