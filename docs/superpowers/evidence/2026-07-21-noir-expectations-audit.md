# Noir cross-check audit of corpus expected.json truth sets

Date: 2026-07-20 (report named for 2026-07-21 delivery)
Tool: OWASP Noir v1.2.0 (`brew install owasp-noir/noir/noir`, binary at /opt/homebrew/bin/noir)
Scope: every repo with BOTH `corpus/expectations/<repo>/expected.json` and a local pinned clone:

| repo | expectations | clone used |
|---|---|---|
| umami | api-detect | /Users/yousefh/orca/workspaces/flowlet/api-detect/corpus/.repos/umami |
| papermark | api-detect | /Users/yousefh/orca/workspaces/flowlet/api-detect/corpus/.repos/papermark |
| invoify | api-detect | /Users/yousefh/orca/workspaces/flowlet/corpus-triage/corpus/.repos/invoify |
| skateshop | api-detect | /Users/yousefh/orca/workspaces/flowlet/corpus-triage/corpus/.repos/skateshop |
| taxonomy | api-detect | /Users/yousefh/orca/workspaces/flowlet/corpus-triage/corpus/.repos/taxonomy |
| rallly | api-detect | /Users/yousefh/orca/workspaces/flowlet/corpus-triage/corpus/.repos/rallly (appDir apps/web) |

Method: clones were copied to /tmp/noir-audit/t2/<repo> with node_modules, .next, .git, and all
vendo-injected artifacts (`.vendo/`, `vendor/`, `run/`, `app/api/vendo/`, `src/vendo/`, `vendo/`)
stripped, so Noir saw pinned source only (all six clones carry vendo-init modifications as
untracked files; git status verified). `noir scan <dir> -f json` output was normalized
(dynamic segments `[x]`/`[...x]`/`:x`/`{x}` -> `{seg}`, Next route groups `(g)` removed, trailing
slashes stripped) and diffed against expected.json tools[].method/path. Every discrepancy was
verified against source. Raw artifacts in /tmp/noir-audit/ (noir JSON, diff lists, scripts).

## Headline

**Zero recall misses in five of six repos. Two real labeling misses found, both in umami.**
Bonus: four phantom labels (precision errors) found in papermark — methods the source 405s.

| repo | expected tools | matched | REAL MISS | NOIR FALSE POSITIVE | OUT OF SCOPE / covered | noir blind spots (labels correct) | phantom labels |
|---|---|---|---|---|---|---|---|
| umami | 147 http | 147/147 | **2** | 0 | 1 (CLI artifact) | 0 | 0 |
| papermark | 388 http | 376/388 | 0 | 353 | 1 (CLI artifact) | 8 | **4** |
| invoify | 3 http | 3/3 | 0 | 0 | 0 | 0 | 0 |
| skateshop | 7 http | 7/7 | 0 | 0 | 31 (server actions) | 0 | 0 |
| taxonomy | 10 http | 10/10 | 0 | 3 | 0 | 0 | 0 |
| rallly | 20 http + 64 trpc | 20/20 REST; 60/60 distinct trpc leaf names | 0 | 0 | 22 (catch-all sub-routes) | 0 | 0 |

## umami — 2 REAL MISSES

All 147 expected tools matched Noir 1:1. Noir additionally found two genuine HTTP endpoints
that expected.json lacks. Both exist at pinned SHA af1b6c6 (verified via `git ls-tree`):

| method | path | evidence |
|---|---|---|
| GET | /p/{slug} | `src/app/(collect)/p/[slug]/route.ts:12` — `export async function GET(...)`; tracking-pixel collect endpoint (serves 1x1 GIF, internally invokes the POST /api/send handler) |
| GET | /q/{slug} | `src/app/(collect)/q/[slug]/route.ts:10` — `export async function GET(...)`; link-redirect collect endpoint (records click, redirects) |

Why the labels missed them: they are the only two route handlers outside `src/app/api/` —
the labeling sweep (and my own first inventory pass) only walked `**/api/**`. A "scope: only
/api" defense does not hold because the sibling collect endpoint `POST /api/send` IS labeled.
Root-cause pattern worth noting for other repos: **route handlers outside /api are a labeling
blind spot.**

Out of scope: 1 `cli://umami` entry (Noir js_cli tech reading env vars from next.config.ts).

## papermark — 0 real misses, 4 phantom labels

376/388 expected matched. Noir emitted 730 endpoints; the 353 Noir-only HTTP entries are ALL
method fanout on paths already present in expected.json (0 novel paths). Cause: Noir assumes
pages-router default-export handlers accept every HTTP method when it cannot statically narrow
`req.method` branching. I independently derived actual allowed methods for all 232 pages/api
handlers (regex on `req.method` checks + following `export { default } from "@/ee/..."`
re-exports, plus manual reads of the 17 wrapper/sub-router files: ee conversations-route,
team-conversations-route, team-faqs-route, dataroom-invitations, bulk-import, limits,
generate, slack switch, health): in no file does the source handle a method the labels lack.
All 353 fanned-out methods hit `res.status(405)` paths -> NOIR FALSE POSITIVES.
(1 more Noir-only entry is `cli://docx-sanitizer` from a python script — out of scope.)

Noir blind spots (12 expected-only entries): 8 are genuine endpoints Noir missed, labels
correct — Noir failed on the `if (req.method === "GET") {...}; if (req.method !== "POST") 405`
double-branch idiom (POST side missed):
POST /api/links/download/verify (pages/api/links/download/verify.ts:39),
POST /api/notification-preferences/dataroom (pages/api/notification-preferences/dataroom.ts:18),
POST /api/unsubscribe/dataroom (pages/api/unsubscribe/dataroom/index.ts:12),
POST /api/unsubscribe/yir (pages/api/unsubscribe/yir/index.ts:12),
POST /api/webhooks/services/{path} (pages/api/webhooks/services/[...path]/index.ts:145),
POST on all three export-visits routes (pages/api/teams/[teamId]/{datarooms/[id],documents/[id],datarooms/[id]/groups/[groupId]}/export-visits.ts).
No action needed.

**PHANTOM LABELS (precision errors — expected.json claims methods the source 405s).** In all
four files the 405 branch sets a misleading `Allow` header that the labeler apparently trusted:

| labeled tool | reality | evidence |
|---|---|---|
| GET /api/teams/{teamId}/documents/agreement | handler implements POST only; else-branch 405s with `Allow: GET, POST` | `pages/api/teams/[teamId]/documents/agreement.ts:20` (only `req.method === "POST"` branch), 405 at :188 |
| GET /api/teams/{teamId}/documents/{id}/versions | handler implements POST only; 405 branch sets `Allow: GET` (!) | `pages/api/teams/[teamId]/documents/[id]/versions/index.ts:24` (only POST branch), 405 at :266-267 |
| POST /api/teams/{teamId}/datarooms/{id}/folders/{name} | handler implements GET only; 405 sets `Allow: GET, POST` | `pages/api/teams/[teamId]/datarooms/[id]/folders/[...name].ts:14` (only GET branch), 405 at tail |
| POST /api/teams/{teamId}/datarooms/{id}/folders/parents/{name} | handler implements GET only; 405 sets `Allow: GET, POST` | `pages/api/teams/[teamId]/datarooms/[id]/folders/parents/[...name].ts:14` (only GET branch), 405 at :94-95 |

(Contrast: the non-dataroom `pages/api/teams/[teamId]/folders/[...name].ts` is labeled GET-only,
correctly — the labeler followed the honest `Allow: GET` header there.)

Note: a handful of handlers have no method check at all (e.g. `pages/api/health.ts` answers any
method); labels list the canonical method only — reasonable canonicalization, not flagged.

## invoify — clean

3/3 exact (POST /api/invoice/{export,generate,send}). Nothing else found by Noir.

## skateshop — clean

7/7 exact (incl. uploadthing GET+POST via `export const { GET, POST } = createRouteHandler`,
src/app/api/uploadthing/route.ts). Noir's 31 extra entries are all Next.js **server actions**
(`"use server"` files src/lib/actions/{cart,product,store,stripe,order,notification}.ts) which
Noir renders as fake `POST /<functionName>` endpoints. Server actions are not URL-addressable
REST endpoints (invoked via POST to the page URL with a Next-Action header) and the truth-set
schema has no server-action kind — OUT OF SCOPE. If the corpus ever wants a server-action
detection lane, skateshop is the richest fixture (31 actions).

## taxonomy — clean

10/10 exact. Noir's 3 extras (PUT/PATCH/DELETE /api/auth/{nextauth}) are method fanout on the
NextAuth v4 pages catch-all (`pages/api/auth/[...nextauth].ts:6` — `export default
NextAuth(authOptions)`); NextAuth's internal handler serves GET/POST only -> FALSE POSITIVE.

## rallly — clean (both REST and tRPC)

REST: all 20 expected http tools matched; no expected-only. Noir's 22 non-tRPC extras are
finer-grained sub-routes of Hono apps mounted inside labeled Next catch-alls, all within the
labeled method sets:
- /api/event/{seg}/{ics,google-calendar,outlook,office365,yahoo} — covered by GET /api/event/{route} (route.ts exports GET only, matches label)
- /api/house-keeping/{auto-close-polls,delete-inactive-polls,remove-deleted-polls} — covered by GET /api/house-keeping/{method}
- /api/legacy/{admin,p}/{seg} — covered by GET /api/legacy/{route}
- /api/private/{docs,openapi,polls,polls/{seg},participants,results} incl. POST /api/private/polls and DELETE /api/private/polls/{seg} — covered by GET/POST/DELETE /api/private/{route} (route.ts:607-609 exports exactly GET, POST, DELETE)
- /api/licensing/v1/licenses{,/actions/validate-key} POST — covered by GET+POST /api/licensing/v1/{route} (route.ts:108-109)
- GET /auth/{seg}, GET /callback/{seg} — Hono app in src/lib/oauth/server.ts:46,102, mounted with `basePath: "/api/integrations"` (src/app/api/integrations/[...connection]/route.ts:14), so real URLs fall under the labeled GET/POST /api/integrations/{connection}
- GET /api/trpc/{seg} — the tRPC transport catch-all, represented in labels as 64 procedure tools instead

tRPC: Noir detected 60 distinct procedure names (rendered as /api/trpc/<leaf>, GET for .query /
POST for .mutation); expected's 64 procedures collapse to exactly those same 60 distinct leaf
names (4 duplicate leaves across routers, e.g. `list`). Set difference empty both ways. Source
count cross-check: exactly 64 `.query(`/`.mutation(` call sites under apps/web/src/trpc/routers.

## Noir operational notes

- Homebrew formula compiles Crystal from source; install took ~10 min total.
- v1.2.0 verb CLI: `noir scan <dir> -f json -o out.json --no-log --no-spinner`.
- Strengths seen: resolves Hono sub-routers inside Next catch-alls; parses uploadthing/route
  tables; finds app-router routes outside /api.
- Weaknesses seen: fans out all methods on pages-router default handlers it can't narrow
  (353 FPs on papermark alone); misses the GET-branch + `!== POST` guard idiom (8 papermark
  endpoints); renders server actions and CLI env-parsers as endpoints; missed the tRPC
  transport's own POST export.

## Recommended actions

1. **umami expected.json: add 2 tools** — GET /p/{slug} and GET /q/{slug} (collect endpoints).
   Until then, umami recall=1.000 scores are measured against a truth set missing 2 of 149
   real endpoints.
2. **papermark expected.json: remove 4 phantom tools** (list above). They can never succeed
   (405) and will silently reward detectors that copy the same misleading Allow headers, and
   penalize precision of detectors that read the actual branches.
3. Labeling process: sweep ALL route handlers (`app/**/route.ts*`), not just `**/api/**`, and
   derive methods from implemented branches, never from `Allow` headers or comments.
