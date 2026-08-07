# openstatus labeling notes

Pinned SHA f7dc9efe. Citations below are rooted at `apps/dashboard`, the app the
existing labels were derived from. The grades do not depend on that choice:
`apps/web` and `apps/status-page` carry their own copies of the tRPC catch-alls
differing only in import paths, and all three mount the same `edgeRouter` /
`lambdaRouter`. `apps/status-page` also has its own `[...nextauth]` route
(`apps/web` has none), likewise adapter-backed and writing on sign-in
(`apps/status-page/src/lib/auth/index.ts:47-51` `.update(viewer)`).

## Curated `ai-expected.json` risk rows (hand-verified, FROZEN)

Every row below is a catch-all URL graded at its WORST reachable operation, per
the labeling rule the README now states. Each grade was read from the pinned
source and independently confirmed by a second reviewer given only the handler
excerpt, the then-current label and the rule. Do not relabel these from model
output.

- `GET /api/auth/{nextauth}` → `write` (`POST` was already `write`). One opaque
  pair of handlers fronts the whole NextAuth surface —
  `apps/dashboard/src/app/api/auth/[...nextauth]/route.ts:3`:
  `export const { GET, POST } = handlers;`. The worst operation behind it writes
  user rows: `apps/dashboard/src/lib/auth/index.ts:48`: `.update(user)` inside
  the `signIn` callback (lines 47-60, and again at 66-74 and 80-84), on top of
  the row-creating adapter at `apps/dashboard/src/lib/auth/adapter.ts:14`:
  `...(DrizzleAdapter(db, {`. Nothing behind this URL deletes in bulk or
  irreversibly — `grep -rni delete` over both auth directories and both auth
  route directories returns no match — so `destructive` is not earned and
  `write` is the worst grade.

- `GET`/`POST /api/trpc/edge/{trpc}` → `destructive`. One handler serves both
  methods over the entire edge router
  (`apps/dashboard/src/app/api/trpc/edge/[trpc]/route.ts:24`:
  `export { handler as GET, handler as POST };`), and the router mounts the user
  procedures (`packages/api/src/edge.ts:35`: `  user: userRouter,`). The worst
  operation reachable behind the URL is account deletion —
  `packages/api/src/router/user.ts:18`:
  `deleteAccount: protectedProcedure.mutation(async ({ ctx }) => {` →
  `packages/services/src/user/delete.ts:174-175`:
  `await tx.delete(session).where(eq(session.userId, userId));` /
  `await tx.delete(account).where(eq(account.userId, userId));`, which also
  strips non-owner memberships (`delete.ts:165-172`), blanks the user's PII
  (`delete.ts:178-181`, `email: ""`) and fans out into `deleteMonitors` /
  `deletePage` / `deleteNotification` for every owned workspace
  (`delete.ts:138-140`, `:149-151`, `:160-162`). Many rows, many tables, not
  recoverable.

- `GET`/`POST /api/trpc/lambda/{trpc}` → `destructive`. Same one-handler shape
  (`apps/dashboard/src/app/api/trpc/lambda/[trpc]/route.ts:25`) over the lambda
  router, which mounts the Stripe webhook procedures
  (`packages/api/src/lambda.ts:10`: `  stripeRouter: stripeRouter,`). Its worst
  operation is the downgrade cleanup —
  `packages/api/src/router/stripe/webhook.ts:210`:
  `customerSubscriptionDeleted: webhookProcedure.mutation(async (opts) => {` —
  which in one transaction hard-deletes every status page but the oldest
  (`webhook.ts:274-276`, each cascading to its components, subscribers, status
  reports and maintenances), every notification channel but one
  (`:301-305`), every non-owner membership (`:308-316`) and every pending
  invitation (`:319-322`). Bulk, and keyed only on
  `eq(workspace.stripeId, customerId)` (`:236`).

  The route's only gate is a header check —
  `apps/dashboard/src/lib/trpc/shared.ts:22` `guardTRPCSource` 401s unless
  `x-trpc-source` is `"server"` or `"client"` — so reachability is not in doubt.

## Rows deliberately LEFT at their current grade

- `POST /api/onboarding/checks` stays `write`. The handler persists nothing
  itself — `packages/services/src/monitor/stream-monitor-preview.ts:173` uses
  `const tx = getReadDb(ctx);` and the docstring (line 164) states "Does NOT
  persist to Tinybird. Ephemeral, onboarding-only." But it fans the monitor's
  OWN configured method out across every active region
  (`stream-monitor-preview.ts:209-218`, `method: monitor.method ?? "GET"`), so a
  monitor configured with a POST target has its request replayed ~28 times
  against a third-party URL. That is an outbound side effect the caller cannot
  take back, which the rule now names as a `write`, so the row stands.
