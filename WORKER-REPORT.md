# W-ROUTES Worker Report

## Files changed

- `packages/vendo-cli/src/tools/route-scan.ts`
  - Added bounded deterministic import/re-export following for route verb extraction.
  - Supports relative imports, `@/` imports, and `tsconfig.json` `compilerOptions.paths` aliases such as `@lib/*`.
  - Follows star re-exports and default re-export shapes, including `export { handler as default } from "...";`.
  - Detects `defaultHandler({ GET: ..., POST: ... })` method-key maps.
  - Treats `createNextApiHandler(...)` Pages API wrappers as `GET` and `POST`.
  - Uses POST for Pages API webhook/default handlers when `bodyParser: false`, route path ends in `/webhook`, or cal-com's dynamic integration `handlerMap` delegates are present.
  - Kept route-scan tools fail-closed; `annotationsFor` and security docs were not touched.

- `packages/vendo-cli/src/tools/route-scan.test.ts`
  - Added coverage for star re-exports, named default re-exports through tsconfig paths, `defaultHandler` maps, tRPC wrappers, webhook POST tiebreaks, default webhook re-exports, and cal-com integration handler maps.

## Final offline diag

Command:

```sh
DIAG_BATCH=all DIAG_SHAPES_DIR=/private/tmp/claude-501/-Users-yousefh-orca-workspaces-flowlet-batch-b-quality/c6537ca3-19a7-436f-932c-af364c97ed4b/scratchpad/pinned-routes DIAG_EXPECTATIONS_DIR=$PWD/corpus/expectations DIAG_OUT=/tmp/diag-routes.json pnpm --filter @vendoai/cli exec vitest run test/__diag.corpus.test.ts
```

Verbatim summary:

```text
✓ test/__diag.corpus.test.ts (1 test) 6480ms
Test Files  1 passed (1)
Tests  1 passed (1)
```

| Repo | Actual | Expected | Precision | Recall | Missing | Spurious |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| umami | 147 | 147 | 1 | 1 | 0 | 0 |
| skateshop | 7 | 7 | 1 | 1 | 0 | 0 |
| taxonomy | 10 | 10 | 1 | 1 | 0 | 0 |
| invoify | 3 | 3 | 1 | 1 | 0 | 0 |
| papermark | 388 | 388 | 1 | 1 | 0 | 0 |
| cal-com | 114 | 114 | 1 | 1 | 0 | 0 |
| dub | 617 | 215 | 0.347 | 0.995 | 1 | 400 |
| formbricks | 120 | 120 | 1 | 1 | 0 | 0 |
| inbox-zero | 194 | 194 | 1 | 1 | 0 | 0 |
| openstatus | 8 | 8 | 1 | 1 | 0 | 0 |
| teable | 2 | 2 | 1 | 1 | 0 | 0 |
| vercel-commerce | 1 | 1 | 1 | 1 | 0 | 0 |

## Gate summaries

Command:

```sh
pnpm --filter @vendoai/cli test
```

Verbatim summary:

```text
Test Files  43 passed | 1 skipped (44)
Tests  402 passed | 1 skipped (403)
```

Note: the skipped file is the untracked diagnostic test when `DIAG_*` env vars are absent; the explicit offline diagnostic gate above ran and passed with env vars set.

Command:

```sh
pnpm build && pnpm typecheck && pnpm lint
```

Verbatim summaries:

```text
build: Tasks:    19 successful, 19 total
typecheck: Tasks:    30 successful, 30 total
lint: Tasks:    2 successful, 2 total
```

## Label discrepancies and deliberate non-fixes

- Dub remaining missing: `getOgAvatarSeed	GET	/api/og/avatar/{[...seed]}	write`.
- Evidence: the pinned route exists at `dub/apps/web/app/api/og/avatar/[[...seed]]/route.tsx` and exports `GET`; route-scan emits the normalized path `/api/og/avatar/{seed}`, producing the paired spurious `getOgAvatarSeed	GET	/api/og/avatar/{seed}	write`.
- I did not change optional catch-all normalization because other corpus expectations already use normalized optional catch-all params, for example papermark expects `/api/conversations/{conversations}` for `[[...conversations]].ts`.
- I did not edit `corpus/expectations/*`.
- I did not address dub's large `(ee)` spurious label gap; the brief says that is owned by a separate label worker.
- I did not modify `annotationsFor`, security README text, or any fail-closed route-scan annotation policy.
