# W-DUB-LABELS Worker Report

## Summary

- Updated `corpus/expectations/dub/expected.json` from the pinned dub source at SHA `ea29e2977f2db6f9685bfa96c147624aa7d5411e`.
- Previous label count: 215 tools / 215 annotations.
- New label count: 629 tools / 629 annotations.
- Tools added: 414.
- Pre-existing tool/annotation corrections: none. The original 215 tool entries and matching annotations remain unchanged in value and relative order.

## Per-directory Counts

| Source directory | Route files | Tools in final labels | Tools added |
| --- | ---: | ---: | ---: |
| `apps/web/app/api` | 142 | 218 | 3 |
| `apps/web/app/(ee)/api` | 349 | 411 | 411 |
| Total | 491 | 629 | 414 |

The 3 added `apps/web/app/api` tools are exported `OPTIONS` handlers that were not in the old labels:

- `OPTIONS /api/oauth/token` from `api/oauth/token/route.ts:32`
- `OPTIONS /api/oauth/userinfo` from `api/oauth/userinfo/route.ts:78`
- `OPTIONS /api/qr` from `api/qr/route.tsx:106`

## Spot-check Table

Random sample seed: `409`.

| Tool | Method/path | Source evidence |
| --- | --- | --- |
| `postFolders` | `POST /api/folders` | `api/folders/route.ts:41` exports `POST` |
| `postPostbacksCallback` | `POST /api/postbacks/callback` | `api/postbacks/callback/route.ts:12` exports `POST` |
| `postCronPayoutsProcessUpdates` | `POST /api/cron/payouts/process/updates` | `(ee)/api/cron/payouts/process/updates/route.ts:23` exports `POST` |
| `getGroupsCount` | `GET /api/groups/count` | `(ee)/api/groups/count/route.ts:8` exports `GET` |
| `postProjectsSlugDomains` | `POST /api/projects/{slug}/domains` | `api/(old)/projects/[slug]/domains/route.ts:1` re-exports `api/domains/route.ts`; target `api/domains/route.ts:96` exports `POST` |
| `postCronCommissionsReferralsBackfill` | `POST /api/cron/commissions/referrals/backfill` | `(ee)/api/cron/commissions/referrals/backfill/route.ts:18` exports `POST` |
| `getCronStreamsUpdateWorkspaceClicks` | `GET /api/cron/streams/update-workspace-clicks` | `(ee)/api/cron/streams/update-workspace-clicks/route.ts:182` exports `GET` |
| `postCronExportEventsWorkspace` | `POST /api/cron/export/events/workspace` | `(ee)/api/cron/export/events/workspace/route.ts:30` exports `POST` |
| `getPartnerProfilePayoutsCount` | `GET /api/partner-profile/payouts/count` | `(ee)/api/partner-profile/payouts/count/route.ts:8` exports `GET` |
| `postIntercomWebhook` | `POST /api/intercom/webhook` | `(ee)/api/intercom/webhook/route.ts:12` exports `POST` |
| `getCronPartnerProgramSummary` | `GET /api/cron/partner-program-summary` | `(ee)/api/cron/partner-program-summary/route.ts:15` exports `GET` |
| `postAdminPartnersPartnerIdPlatforms` | `POST /api/admin/partners/{partnerId}/platforms` | `(ee)/api/admin/partners/[partnerId]/platforms/route.ts:17` exports `POST` |
| `getOgPartnerRewind` | `GET /api/og/partner-rewind` | `api/og/partner-rewind/route.tsx:17` exports `GET` |
| `getPartnerProfileProgramsProgramIdLinks` | `GET /api/partner-profile/programs/{programId}/links` | `(ee)/api/partner-profile/programs/[programId]/links/route.ts:19` exports `GET` |
| `getProjects` | `GET /api/projects` | `api/(old)/projects/route.ts:1` re-exports `api/workspaces/route.ts`; target `api/workspaces/route.ts:19` exports `GET` |
| `getFraudRules` | `GET /api/fraud/rules` | `(ee)/api/fraud/rules/route.ts:32` exports `GET` |
| `postProjects` | `POST /api/projects` | `api/(old)/projects/route.ts:1` re-exports `api/workspaces/route.ts`; target `api/workspaces/route.ts:61` exports `POST` |
| `postWorkflowsCreatePartnerCommission` | `POST /api/workflows/create-partner-commission` | `(ee)/api/workflows/create-partner-commission/route.ts:64` destructures `POST` from `serve<Input>(...)` |
| `getEmbedReferralsEarningsTimeseries` | `GET /api/embed/referrals/earnings/timeseries` | `(ee)/api/embed/referrals/earnings/timeseries/route.ts:7` exports `GET` |
| `getNetworkPrograms` | `GET /api/network/programs` | `(ee)/api/network/programs/route.ts:12` exports `GET` |

## Edge Cases Resolved

- Route groups: stripped `(ee)` and `(old)` from URL paths, so `(ee)/api/...` is labeled as `/api/...` and old project aliases remain under `/api/projects/...`.
- Scope exclusions: excluded `/api/vendo/*` and non-API routes such as `wellknown/**` and host-specific `app.dub.co` / `partners.dub.co` route files.
- Re-exports: followed `export * from ...` and `export { METHOD } from ...` to source-owned target routes before labeling methods. Examples include old project aliases, `admin/fraud-alerts`, and Stripe webhook test/sandbox routes.
- Wrappers: labeled the exported HTTP method for `withWorkspace`, `withAdmin`, `withCron`, `withPartnerProfile`, `withAxiom`, `withReferralsEmbedToken`, and similar source-owned wrappers.
- Destructured framework wrappers: labeled `POST` for Upstash workflow routes using `export const { POST } = serve<Input>(...)`.
- Method exports: included `HEAD` and `OPTIONS` when the route file exports them. All route-scan-derived tools keep `readOrWrite: "write"` and `mutating: true`.
- Ordering: preserved the existing route-tree ordering: URL path segments, dynamic segments before static siblings, and method order `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`.

## Validation

- Passed: `python3 -c "import json; json.load(open('corpus/expectations/dub/expected.json'))"`
- Passed: tools and annotations arrays are both length 629; tool names are unique; every annotation name has a matching tool.
- Passed: `pnpm corpus validate`
- Setup note: first `pnpm corpus validate` run failed because `@vendoai/core` had no built `dist/index.js`; ran `pnpm --filter @vendoai/core build`, then validation passed.
