# rallly labeling notes

Pinned SHA 317ceaac.

## Curated `ai-expected.json` risk rows (hand-verified, FROZEN)

The rows below replace mechanically derived grades (tRPC mutation → `write`,
`GET` → `read`) with grades read from the pinned handler source. Each was
independently confirmed by a second reviewer given only the handler excerpt and
the then-current label. Do not relabel these from model output — a future model
disagreeing with a curated row is a bug report about the model, not a reason to
relabel.

### Downgraded to `read` — mutation-shaped binding, read-only body

- `trpc auth.getLoginMethod` → `read`. Declared a mutation only for wire
  compatibility; the body is a single lookup.
  `apps/web/src/trpc/routers/auth.ts:28`:
  `const user = await prisma.user.findUnique({`. The handler's own comment
  (lines 24-27) says: "This should probably be a query instead of a mutation,
  but we need to keep it as a mutation for now to avoid breaking changes."
- `trpc dashboard.stats` → `read`. Five counts plus an in-memory ability
  computation. `apps/web/src/trpc/routers/dashboard.ts:32`:
  `prisma.poll.count({`. The one non-obvious call,
  `getTotalSeatsForSpace` (`apps/web/src/features/space/utils.ts:62-104`),
  only reads a cached license or a Stripe subscription.
- `trpc polls.infiniteChronological` → `read`. Delegates to `getPolls`, whose
  transaction contains only reads. `apps/web/src/features/poll/data.ts:180-182`:
  `const [totalCount, polls] = await prisma.$transaction([` /
  `prisma.poll.count({ where }),` / `prisma.poll.findMany({`.

### Upgraded from `read` — side effects hidden behind `GET`

- `GET /api/house-keeping/{method}` → `destructive`. A cron-authenticated Hono
  catch-all whose three sub-routes ALL mutate, and one deletes in bulk. Graded
  at the maximum risk in the union (fail-closed).
  `apps/web/src/features/poll/mutations.ts:223`:
  `const deleted = await prisma.poll.deleteMany({` — reached from
  `app/api/house-keeping/[...method]/route.ts:62-63`
  (`app.get("/remove-deleted-polls", ...)` → `await removeDeletedPolls()`),
  which loops in batches of 100 (`mutations.ts:194-229`). The sibling routes
  soft-delete (`deleteInactivePolls`, `mutations.ts:125`) and bulk-update
  (`autoClosePolls`, `mutations.ts:176` `prisma.$executeRaw` UPDATE), so no
  sub-path of this GET is read-only.
- `GET /api/stripe/buy-license` → `write`. Creates an external Stripe Checkout
  session. `app/api/stripe/buy-license/route.ts:11`:
  `const result = await createLicenseCheckoutSession({ product });` →
  `apps/web/src/features/licensing/mutations.ts:170`:
  `const session = await stripe.checkout.sessions.create({`.
- `GET /api/stripe/portal` → `write`. Creates an external Stripe billing-portal
  session. `app/api/stripe/portal/route.ts:43`:
  `await createStripePortalSession({ customerId }),` →
  `apps/web/src/features/billing/mutations.ts:18`:
  `const portalSession = await stripe.billingPortal.sessions.create({`.
- `GET /api/updates` → `write`. Upserts a telemetry row for the calling
  instance. `app/api/updates/route.ts:107`:
  `await prisma.registeredInstance.upsert({` — inside `after()` (line 102), so
  it lands after the response but still mutates stored state.

## Rows deliberately LEFT at their current grade

Investigated against source and intentionally not changed, so a future run does
not re-litigate them:

- `trpc polls.markAsDeleted` stays `write`: soft delete only.
  `apps/web/src/trpc/routers/polls.ts:571`:
  `data: { deleted: true, deletedAt: new Date() },` — reversible flag, not
  destruction.
- `trpc eventTypes.softDelete` stays `write`: soft delete only.
  `apps/web/src/trpc/routers/event-types.ts:87-90`:
  `data: {` / `deleted: true,` / `deletedAt: new Date(),`.
- `trpc spaces.inviteMember` stays `write`: creates an invite and sends mail
  (`apps/web/src/trpc/routers/spaces.ts:403` `prisma.spaceMemberInvite.create({`).
  The only `delete` in the procedure is a compensating rollback when the invite
  email fails (line 427), not destructive intent.
- `GET /api/better-auth/{all}`, `GET`/`POST /api/integrations/{connection}`
  stay as labeled: SDK/OAuth catch-all unions whose per-method reachability is
  not decidable from this repo's source. `api/better-auth/[...all]/route.ts:5`
  exports one opaque `toNextJsHandler(authLib)` pair; the integrations route
  persists credentials inside an `onConnect` callback
  (`api/integrations/[...connection]/route.ts:45` `saveOAuthCredentials`) whose
  triggering method lives inside `OAuthIntegration`. Grading these needs a
  decision about how to label catch-all unions, not more source reading.
- `trpc polls.reopen`, `spaces.acceptInvite`, `spaces.cancelInvite`,
  `spaces.removeMember`, `spaces.removeImage` stay `write`: each performs a
  single-row (or single-object) hard delete of a re-creatable record —
  `polls.ts:1125` `prisma.scheduledEvent.delete({`, `spaces.ts:493`
  `tx.spaceMemberInvite.delete({`, `spaces.ts:629`
  `prisma.spaceMemberInvite.delete({`, `spaces.ts:545`
  `prisma.spaceMember.delete({`, `spaces.ts:862` `deleteImageFromS3(oldImageKey)`.
  Whether a single irreversible row delete crosses into `destructive` is a
  threshold the labeling rule does not fix, so these were left alone rather
  than moved on a judgment call.
