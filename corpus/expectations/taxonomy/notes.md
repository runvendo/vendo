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

## Rows deliberately LEFT at their current grade

- `GET /api/auth/{nextauth}` stays as labeled. `pages/api/auth/[...nextauth].ts:6`
  is `export default NextAuth(authOptions)` — a catch-all union in which
  `/callback/:provider` mints a session while other sub-paths are read-only.
  Which grade a catch-all union should carry is a labeling-policy decision, not
  something this repo's source settles.
