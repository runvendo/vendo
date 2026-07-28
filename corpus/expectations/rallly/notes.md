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
- `trpc polls.reopen`, `spaces.acceptInvite`, `spaces.cancelInvite`,
  `spaces.removeMember`, `spaces.removeImage` stay `write`, now on the rule
  rather than for want of one: `destructive` takes bulk or irreversible loss,
  and each of these hard-deletes exactly ONE easily re-created row or object.
  Verified single, not `deleteMany` and not in a loop:
  `polls.ts:1125` `await prisma.scheduledEvent.delete({` by
  `poll.scheduledEventId` (guarded by `if (poll.scheduledEventId)` at `:1124`);
  `spaces.ts:493` `await tx.spaceMemberInvite.delete({` by the id of the one
  invite fetched at `:455`; `spaces.ts:629`
  `await prisma.spaceMemberInvite.delete({` by `input.inviteId`;
  `spaces.ts:545` `const deletedMember = await prisma.spaceMember.delete({` by
  `input.memberId` (the `:549` sibling call is a `count`, not a delete);
  `spaces.ts:862` `await deleteImageFromS3(oldImageKey);` for the single key
  previously on `ctx.space.image`, guarded by `if (oldImageKey)` at `:861`.
- `trpc user.submitFeedback` stays `write` — the row that would have been graded
  `read` by the bare mutation test, since it writes nothing to a database.
  `apps/web/src/trpc/routers/user.ts:125`: `      sendRawEmail({` sends one mail
  to the hardcoded `feedback@rallly.co` (`:126`) carrying the caller's name,
  email and free text (`:129`). Mail sent is an outbound effect the caller
  cannot take back, which the rule names as a `write`.
- `POST /api/integrations/{connection}` stays `write` — already the grade its
  whole URL carries (see the catch-all section below); only its `GET` twin moved.

## Curated catch-all rows (hand-verified, FROZEN)

Both URLs below are graded at their WORST reachable operation, the same grade on
every method they export, per the rule the README now states. Independently
confirmed by a second reviewer given only the excerpt, the then-current labels
and the rule.

- `GET`/`POST /api/integrations/{connection}` → `write` (the `GET` row moved from
  `read`). One handler serves both methods —
  `apps/web/src/app/api/integrations/[...connection]/route.ts:73-74`:
  `export const GET = handler;` / `export const POST = handler;` — over a Hono
  app built inside `OAuthIntegration` (`apps/web/src/lib/oauth/server.ts:16`),
  whose OAuth callback (`server.ts:102`) invokes the route's `onConnect` at
  `server.ts:141`. That callback persists encrypted OAuth tokens:
  `route.ts:45` `const credential = await saveOAuthCredentials({` →
  `apps/web/src/features/credentials/mutations.ts:42`:
  `const credential = await prisma.credential.create({` with
  `secret: encrypt(JSON.stringify(tokens), env.SECRET_PASSWORD),` (`:48`), then
  creates a calendar connection (`route.ts:53`) and syncs it (`route.ts:63`).
  Nothing behind this URL deletes anything, so `write` is the worst grade.

- `GET`/`POST /api/better-auth/{all}` → `destructive` (both rows moved). One
  opaque handler pair fronts the whole better-auth surface —
  `apps/web/src/app/api/better-auth/[...all]/route.ts:5`:
  `const { POST: authPost, GET: authGet } = toNextJsHandler(authLib);`. The
  worst operation behind it is a hard account delete, reachable because this
  repo mounts the admin plugin: `apps/web/src/lib/auth.ts:139`: `    admin(),`.
  The endpoint that plugin registers is not in this repo's source, so it was
  read from the pinned dependency (`better-auth` `^1.6.0`,
  `apps/web/package.json:61`) — `dist/plugins/admin/admin.mjs:83`:
  `			removeUser: removeUser(opts),` in the plugin's unconditional endpoint map,
  implemented in `dist/plugins/admin/routes.mjs` as
  `createAuthEndpoint("/admin/remove-user"` whose own description reads
  `"Delete a user and all their sessions and accounts. Cannot be undone."` and
  whose body calls `await ctx.context.internalAdapter.deleteUser(ctx.body.userId);`.
  Irreversible, so `destructive`.

  Two things this row is NOT resting on: better-auth's `user.deleteUser`
  endpoint is *not* enabled (there is no `deleteUser` key anywhere in
  `apps/web/src/lib/auth.ts`), and rallly's own account deletion goes through
  `trpc user.deleteMe`, already labeled `destructive`. The admin plugin's
  `remove-user` is a separate, always-mounted path, and a catch-all is graded at
  the worst thing behind it even when the host app never links to it.
