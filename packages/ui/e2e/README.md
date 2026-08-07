# The browser suite — what actually runs where, and what it actually covers

Nothing here runs in CI (Yousef's call, 2026-08-06: zero browser in CI —
headless CI mis-resolves `:focus-visible` and `light-dark()`, which several of
these specs assert directly). The browser suite is the LOCAL pre-PR gate.

| Tier | Command | What it is |
|---|---|---|
| **smoke** | `pnpm --filter @vendoai/ui test:ui` | `smoke.spec.ts` only. 15 tests, ~35s. The things that must never silently stop working. |
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
| C2 | an activity row reads in the owner's words, not the guard's JSON | **no browser test** | jsdom only: `test/chrome/activity-semantics.test.ts`; plus the `postcheck-a/a2` screenshot (a one-shot record, not a gate) |
| C5 | a two-money ask shows both amounts and no wrong money sentence | **no browser test** | jsdom only: `test/chrome/approval-money.test.tsx`, `nested-money.test.ts`; plus `postcheck-a/a3` |
| H6 | the card and its queue row read from ONE ladder | **yes** | `pass3-consumer-voice.spec.ts` (b) |
| H9 | collapsing the workspace is final; the stage cannot re-open it | **yes** | `smoke.spec.ts` |
| H10 | ···→Activity→··· leaves one tab stop and a named panel | **yes**, with real key presses | `center-a11y.spec.ts` |
| H11 | a live tile preview is `inert`, not just `aria-hidden` | **yes**, incl. a planted focusable that the browser refuses | `center-a11y.spec.ts` |
| H12 | the takeover inerts the host page and adds no second `<main>` | **yes** | `center-a11y.spec.ts` |
| H15 | three attention surfaces cost ONE poller | **yes**, by counting requests (~20s) | `approvals-poller-proof.spec.ts` |
| H16 | a tile the viewport gate has not seen boots nothing; fails OPEN | **yes**, by driving IntersectionObserver directly | `center-a11y.spec.ts` |
| H17 | a navigation carries focus with it | **no browser test in CI** | proven once by the wave E2E (`integration-v2`, frame 25) against the real host; not a gate |
| H18 | arrows move focus in the rail, they never activate | **yes** (cheap in smoke, deep in center-a11y) | `smoke.spec.ts`, `center-a11y.spec.ts` |
| M33 | every meaning-carrying indicator clears 3:1 | **yes**, computed in the browser | `center-a11y.spec.ts` |
| M34 | the mobile sheet takes focus, traps it, returns it on Escape | **yes** | `center-a11y.spec.ts` |
| §8 | a build animates exactly ONE thing | **yes**, sampled across the whole build window | `smoke.spec.ts` |
| mobile 390px | the thread renders, fits and answers on a phone | **yes**, plus an axe sweep at 390px | `smoke.spec.ts`, `center-a11y.spec.ts` |

### Browser-only mechanisms

Four things cannot be answered by jsdom at all. Each has at least one
assertion in a real Chromium:

| Mechanism | Assertion |
|---|---|
| `inert` | `center-a11y.spec.ts` H11 (a planted button inside a preview refuses focus) and H12 (every host sibling of the portal is inert) |
| focus order | `center-a11y.spec.ts` H10 (one tab stop, Tab leaves the tablist), H18 (an arrow walk changes nothing), M34 (12 Tabs stay inside the sheet) |
| `IntersectionObserver` | `center-a11y.spec.ts` H16, driven through a controlled observer, both branches — gated, and fail-open when the API is missing |
| `:has()` | `smoke.spec.ts` §8 — the build-suppression rule is `.fl-thread:has(.fl-appcard-bar[data-state="building"]) …`, and the test reads computed `animationName`, so a `:has()` that stopped matching turns the assertion red |

### Specs that are not part of the default gate

| Spec | Why |
|---|---|
| `screenshots.spec.ts` | writes PNGs; a capture job, not a gate. |
| `mcp-shim.spec.ts` | runs under its own config (`test:mcp-shim`). |
| `eng-222.spec.ts` | currently-RED product defect (`New conversation` never appears in the page thread's sidebar) — tracked, not fixed here; see "Currently RED" below. |
| `live-voice.spec.ts` | needs `OPENAI_API_KEY` and a real model; run it on demand. |

### Currently RED on this branch (product defects, not spec bugs)

Measured on `redesign/postcheck2-gate`, identically under the dev server and the
production build, so none of it is a harness-mode artefact:

| Spec | Symptom | Owner |
|---|---|---|
| `eng-222.spec.ts:49`, `:55` | `New conversation` never appears in the page thread's sidebar | defects worker (center) |
| `keyboard.spec.ts:94` | the Automations tab's `aria-selected` stays `"false"` | defects worker (center rail) |
| `stress.spec.ts:68` | `New conversation` never appears — same root as eng-222 | defects worker (center) |
| `wave3-consumer-voice.spec.ts:86`, `:151` | the Invoices card offers no `Share` / `Change` button | defects worker (cards / apps page) |

`stress.spec.ts` and `wave3-consumer-voice.spec.ts` are in the pre-PR gate, so
**it is red on this branch until those land**. Nothing here was quarantined to
hide it.
