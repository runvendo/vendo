---
"@vendoai/vendo": patch
---

Remove the retired `vendo playground` command's dead server and the inert refine panel.

`startPlaygroundServer` (and the `/playground.js` + `/embed.js` routes it served)
is gone, along with the IIFE entry `app/main.tsx` and the playground half of the
vite bundle step. `browserOpenCommand` — the one live export of the deleted
module — now lives in `cli/shared.ts`. The bundle step no longer runs as
`prebuild`/`pretest`/`pretypecheck`/`pretest:coverage`; the still-live docs embed
bundle is built on demand by `pnpm --filter @vendoai/vendo run build:embed`.

The try surface itself is unchanged: `@vendoai/vendo/try-surface` and
`@vendoai/vendo/try` keep their exports and their behaviour.

Breaking: the try profile's `capabilities.refine` field is removed. It was
always `false`, and the `/api/refine` endpoints its panel called exist nowhere.
