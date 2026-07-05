# Summary

## Shell Polish

Branch: `yousefh409/shell-polish`

Rebased onto current `origin/main` after PR #53.

Implementation commits:
- `a644c69a` Fix scoped overlay clear button layout
- `57bd8ee1` Add persistent VendoRemix affordance option
- `92703c11` Fix VendoRemix affordance review findings

Changes:
- Reserved a right-side gutter in the scoped overlay header so `.fl-scope-clear` stays inline with the scope bar and no longer collides with `.fl-overlay-close`.
- Added `VendoRemix` prop `affordance?: "hover" | "always"` with the default unchanged at `"hover"`.
- Added CSS for `.fl-remix-btn[data-affordance="always"]` so the remix affordance is persistently visible when opted in.
- Updated VendoRemix tests for the default and always-visible affordance modes.

FIXED:
- Review MEDIUM: `VendoRemix` now emits `data-affordance` only for `affordance="always"`; the default mounted button omits the attribute.
- Review LOW: Added a file-read CSS contract test asserting the `always` selector sets `opacity: 1` and `transform: scale(1)`, while the default hidden and hover/focus reveal rules remain present.

Verification:
- `pnpm --filter @vendoai/shell test -- src/remix/VendoRemix.test.tsx`: passed, 10 tests.
- `pnpm test` in `packages/vendo-shell`: passed, 61 files and 334 tests.
- `pnpm build` in `packages/vendo-shell`: passed.
- `pnpm build` at repo root: passed, 19 of 19 turbo tasks.

Notes:
- The shell test suite still emits existing React `act(...)` and in-memory store warnings.
- The root build still emits existing bundle-size, Turbopack NFT trace, and turbo output warnings, with no failures.

## Init Host Friction

Implemented `vendo init` host-app friction fixes in `packages/vendo-cli`:

- Added conservative `next.config.(ts|mjs|js)` wiring in `wireNextApp`.
  - Creates a minimal config when absent.
  - Merges literal `transpilePackages` and `serverExternalPackages` arrays.
  - Skips ambiguous configs and reports manual instructions without editing.
- Added `vendo init --local <vendo-monorepo>`.
  - Packs the local Vendo runtime package closure into `<app>/vendor/`.
  - Copies the monorepo `vendor/fluidkit-*.tgz`.
  - Rewrites host `package.json` with direct `file:vendor/*` deps for `@vendoai/next` and `@vendoai/shell`.
  - Adds pnpm overrides for every packed `@vendoai/*` package plus `fluidkit`, with npm `overrides` fallback when npm is detected.
- Extended generated `.vendo/README.md` with an Events section, including a `charge.posted` payload schema example and producer guidance.

Verification:
- `pnpm build` passed.
- `pnpm --dir packages/vendo-cli test` passed: 28 files, 136 tests.
- `pnpm --dir packages/vendo-cli typecheck` passed.

## FIXED

- Replaced `pnpm --filter <pkg> pack` with `pnpm -C <pkg.dir> pack --pack-destination <vendorDir>`.
- Added a real-pnpm test that packs from a synthetic local repo path containing spaces.
- Preserved existing npm and pnpm override objects while merging only Vendo tarball keys; unsupported override shapes now skip with manual instructions instead of dropping data.
- Preflighted `fluidkit` and package.json rewrites before target writes, then staged tarballs before replacing `vendor/`.
- Updated the generated Events README example to show the full `tools.json` shape and name `ingestVendoEvent()` plus `POST /api/vendo/events/ingest`.

## Zero-Config Voice

Built zero-config voice for Vendo on branch `yousefh409/voice-zero-config`.

## What changed

- Added `POST {basePath}/voice/session` in `@vendoai/server`.
  - Uses the same `resolvePrincipal` request guard as other spend routes.
  - Returns `503` when `OPENAI_API_KEY` is absent.
  - Mints OpenAI Realtime client secrets with `OPENAI_REALTIME_MODEL ?? "gpt-realtime"` and `OPENAI_REALTIME_VOICE ?? "marin"`.
  - Added route-table tests for mint success, upstream failure, missing key, and guarded production requests.

- Added `createVendoVoice()` in `@vendoai/next/client`.
  - Fetches `POST {basePath}/voice/session` for Realtime credentials.
  - Includes `show_table`, `show_key_value`, and `show_money_flow`.
  - `show_money_flow` renders the prewired `Sankey` generated view.
  - Ported the demo-bank source-declaration/replay-registry data binding for `show_table`; valid sources produce refreshable `queries`, invalid sources degrade to snapshots.
  - Includes `list_integrations` and `request_connect` only when the root passes the integrations capability.
  - Adapts manifest host tools through `annotationsToTier` and `executeHostToolCall`.
  - Builds voice instructions with product persona, capability summary, English (US) default, show-before-say rule, and host extras.

- Updated `VendoRoot`.
  - When `capabilities.voice` is true and no `voice` prop is supplied, it creates the packaged voice driver automatically.
  - `voice={false}` opts out.
  - A custom `VoiceDriver` overrides packaged voice.

## Validation

- `pnpm --filter @vendoai/server test` passed.
- `pnpm --filter @vendoai/next test` passed.
- `pnpm --filter @vendoai/shell test` passed.
- `pnpm build` passed.

Notes: shell tests and root build still emit existing warnings (React `act(...)`, no-store provider warnings, Turbopack NFT tracing, and chunk-size warnings), with no failures.

## Rebased

- Rebased `yousefh409/voice-zero-config` onto `origin/main` after PR #53 merged.
- Kept main's scoped-pin implementation in `@vendoai/shell`'s `VendoThread`; `@vendoai/next` now uses the plain `VendoOverlay` path from main.
- Confirmed zero-config voice behavior still survives the rebase:
  - `capabilities.voice === true` and no `voice` prop creates the packaged `createVendoVoice()` driver.
  - `voice={false}` opts out entirely.
  - A custom `VoiceDriver` prop wins over packaged voice.

## FIXED-ROUND-2

- Added guarded `GET|POST {basePath}/voice/tools` in `@vendoai/server` so packaged voice can list and execute CONNECTED Composio tools server-side, with tier mapping and realtime-sized output capping.
- Hardened `/voice/session` mint failures: upstream bodies are not logged or returned; responses use `{ error: "mint failed" }`.
- Bound OpenAI Realtime mints to the guarded principal with a stable privacy-preserving `OpenAI-Safety-Identifier`.
- Validated `show_money_flow` against the Sankey constraints before emitting a generated view; invalid inputs return a repairable tool error and no view.
- Added replay-registry unregister handles and packaged-driver cleanup on teardown/unmount/tool replacement.
- Confirmed zero-config voice behavior after rebasing onto `origin/main` with PR #54/#55:
  - `capabilities.voice === true` and no `voice` prop creates the packaged driver.
  - `voice={false}` opts out entirely.
  - A custom `VoiceDriver` still wins over packaged voice.

Verification after rebase:
- `pnpm --filter @vendoai/server test`: passed, 29 files / 259 tests.
- `pnpm --filter @vendoai/next test`: passed, 6 files / 83 tests.
- `pnpm --filter @vendoai/shell test`: passed, 61 files / 335 tests.
- `pnpm build`: passed, 19 of 19 turbo tasks.

Notes: the suites/build still emit existing React `act(...)`, no-store provider, bundle-size, Turbopack NFT trace, and turbo output warnings, with no failures.
