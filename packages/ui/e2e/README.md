# The browser suite — what actually runs where, and what it actually covers

Nothing here runs in CI (Yousef's call, 2026-08-06: zero browser in CI —
headless CI mis-resolves `:focus-visible` and `light-dark()`, which several of
these specs assert directly). The browser suite is the LOCAL pre-PR gate.

| Tier | Command | What it is |
|---|---|---|
| **smoke** | `pnpm --filter @vendoai/ui test:ui` | `smoke.spec.ts` only. 13 tests, ~35s. The things that must never silently stop working. |
| **full pre-PR** | `pnpm --filter @vendoai/ui test:browser` | everything in `e2e/`. |

The harness is served **production-built** (`vite build` + `vite preview`, ~3.4s).
`VENDO_HARNESS_DEV=1` puts the dev server back for interactive debugging. A gate
that only ever ran on a dev server cannot promise it verified what ships.

## Honest coverage table

"Covered" below means *there is a test that fails if the behaviour is reverted*.
Anything else says so.

### The post-check findings

| # | What it claims | Covered in a real browser? | Where |
|---|---|---|---|
| C1 | a conversation grows no policy banner of its own | **yes** (two-sided: absent on `/composer`, present on `/notice`) | `smoke.spec.ts` |
| C5 | a two-money ask shows both amounts and no wrong money sentence | **no browser test** | jsdom only: `test/chrome/approval-money.test.tsx`, `nested-money.test.ts`; plus `postcheck-a/a3` |
| H6 | the card and its queue row read from ONE ladder | **no browser test** | jsdom only: `test/chrome/card-shell.test.tsx` |
| H9 | collapsing the workspace is final; the stage cannot re-open it | **yes** | `smoke.spec.ts` |
| H17 | a navigation carries focus with it | **no browser test in CI** | proven once by the wave E2E (`integration-v2`, frame 25) against the real host; not a gate |
| §8 | a build animates exactly ONE thing | **yes**, sampled across the whole build window | `smoke.spec.ts` |
| mobile 390px | the thread renders, fits and answers on a phone | **yes** | `smoke.spec.ts` |

### Browser-only mechanisms

These cannot be answered by jsdom at all. `inert`, focus order and
`IntersectionObserver` were each proven only through the full-page workspace;
`VendoPage` and `center-a11y.spec.ts` are gone, so only `:has()` still has a
real-Chromium assertion:

| Mechanism | Assertion |
|---|---|
| `:has()` | `smoke.spec.ts` §8 — the build-suppression rule is `.fl-thread:has(.fl-appcard-bar[data-state="building"]) …`, and the test reads computed `animationName`, so a `:has()` that stopped matching turns the assertion red |

### Specs that are not part of the default gate

| Spec | Why |
|---|---|
| `screenshots.spec.ts` | writes PNGs; a capture job, not a gate. |
| `mcp-shim.spec.ts` | runs under its own config (`test:mcp-shim`). |
