# openstatus labeling notes

## `ai-expected.json` risk rows verified and LEFT unchanged

- `POST /api/onboarding/checks` stays `write`. The handler persists nothing
  itself — `packages/services/src/monitor/stream-monitor-preview.ts:173` uses
  `const tx = getReadDb(ctx);` and the docstring (line 164) states "Does NOT
  persist to Tinybird. Ephemeral, onboarding-only." But it fans the monitor's
  OWN configured method out across every active region
  (`stream-monitor-preview.ts:209-218`, `method: monitor.method ?? "GET"`), so a
  monitor configured with a POST target has its request replayed ~28 times
  against a third-party URL. `write` is defensible on that outbound side effect;
  the labeling rule does not settle whether replaying a user-configured request
  counts as a mutation, so this row was not moved.
- `GET /api/auth/{nextauth}` stays as labeled: NextAuth catch-all union
  (`apps/dashboard/src/app/api/auth/[...nextauth]/route.ts:3`,
  `export const { GET, POST } = handlers;`) where `/callback/:provider` mints a
  session and other sub-paths are read-only.
- `GET /api/trpc/edge/{trpc}` and `GET /api/trpc/lambda/{trpc}` stay as labeled.
  One handler serves both methods over the whole router
  (`apps/dashboard/src/app/api/trpc/edge/[trpc]/route.ts:24`,
  `export { handler as GET, handler as POST };`), so the grade depends on tRPC's
  method semantics across every procedure rather than on any line in this file.

Grading catch-all unions needs a labeling-policy decision (worst-case in the
union vs. per-method), not more source reading.
