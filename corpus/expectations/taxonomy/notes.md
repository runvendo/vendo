# taxonomy labeling notes

Pinned SHA 298a8857.

## Curated `ai-expected.json` risk rows (hand-verified, FROZEN)

Read from the pinned source and independently confirmed by a second reviewer
given only the handler excerpt. Do not relabel from model output.

- `GET /api/users/stripe` → `write` (was the mechanical `GET` → `read`).
  Every path through the handler creates an external Stripe session.
  `app/api/users/stripe/route.ts:25`:
  `const stripeSession = await stripe.billingPortal.sessions.create({` for pro
  users, and line 35 `const stripeSession = await stripe.checkout.sessions.create({`
  for free users. There is no read-only branch.

- `GET /api/auth/{nextauth}` → `write` (`POST` was already `write`), the
  catch-all graded at its worst reachable operation per the rule the README now
  states. `pages/api/auth/[...nextauth].ts:6` is
  `export default NextAuth(authOptions)` — one opaque default export for every
  sub-path and every method. (The App Router copy at
  `app/api/auth/[...nextauth]/_route.ts` is inert: the underscore prefix means
  Next never routes it.) Two things behind the URL change stored state:
  `lib/auth.ts:17`: `  adapter: PrismaAdapter(db as any),` persists the user,
  account and verification-token rows, and `lib/auth.ts:48`:
  `const result = await postmarkClient.sendEmailWithTemplate({` sends the
  magic-link email — an outbound effect the caller cannot take back. Neither is
  bulk or irreversible, so `write` is the worst grade, not `destructive`.
