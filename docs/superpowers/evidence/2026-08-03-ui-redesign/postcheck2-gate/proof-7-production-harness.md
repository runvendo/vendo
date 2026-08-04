# Item 7 — the harness is served PRODUCTION-built, and the checker's mechanism was wrong

## What was claimed
> `verification-eng229.spec.ts:43` pins a string §16 forbids ("Microphone
> permission was denied") and passes only because Playwright serves the harness
> via vite dev.

## What is actually true (measured, both modes)
`developmentMode()` (`src/chrome/dev-mode.ts`) reads `process.env?.NODE_ENV`.
Vite does not inject a `process` global into the browser bundle, and the `?.`
defeats its static `process.env.NODE_ENV` replacement — so `typeof process` is
`undefined` in the harness page in BOTH modes and the dev rails are always off.

Probe (`e2e/zz-probe.spec.ts`, temporary):

    --- DEV  (VENDO_HARNESS_DEV=1, vite dev server) ---
    PROBE {"hasProcess":false,"nodeEnv":null}
    --- PROD (vite build + vite preview) ---
    PROBE {"hasProcess":false,"nodeEnv":null}

So the assertion was not passing because of dev mode. It was simply RED, and had
been since M36 moved the driver's sentence behind the dev rail — in CI too
(`ci.yml` runs `e2e/verification-eng229.spec.ts`). Same for
`jail-and-tree.spec.ts:115`, which pinned the thrown message `"bad"`.

## Full-suite comparison, dev vs production
Identical result — switching to a production build breaks nothing:

    DEV  (VENDO_HARNESS_DEV=1) : 8 failed, 11 skipped, 119 passed (5.1m)
    PROD (build + preview)     : 8 failed, 11 skipped, 119 passed (5.0m)

    same eight, in the same order:
      e2e/eng-222.spec.ts:49  page thread sidebar refreshes (light)
      e2e/eng-222.spec.ts:55  page thread sidebar refreshes (dark)
      e2e/jail-and-tree.spec.ts:107  tree node failures remain contained
      e2e/keyboard.spec.ts:94  workspace tabs rove with arrows
      e2e/stress.spec.ts:68    a sent conversation persists across a reload
      e2e/verification-eng229.spec.ts:42  error banner with Retry
      e2e/wave3-consumer-voice.spec.ts:86   keyless refusal is a consumer sentence
      e2e/wave3-consumer-voice.spec.ts:151  a viewer denied an EDIT gets their own copy

## What changed anyway, and why
The browser suite now builds the harness and serves it with `vite preview`
(3.4s build). The gate should verify the shipped bundle — minified, tree-shaken,
`NODE_ENV=production` statically replaced inside React and every dependency —
not a dev server. And the moment `developmentMode()` starts resolving under
vite (a bundler change, a `process` shim, a Next-hosted harness), a dev-served
suite would silently begin asserting copy that ships to nobody. This closes
that door before it opens. `VENDO_HARNESS_DEV=1` restores the dev server.

## The two stale assertions, fixed
Both now assert the CONSUMER sentence and additionally assert the developer's
half is absent — strictly stronger than what they replaced:

    verification-eng229.spec.ts  "Voice session failed"     + not "Microphone permission"
    jail-and-tree.spec.ts        "Part of this view didn’t load." + not "exploded"

    $ pnpm exec playwright test e2e/verification-eng229.spec.ts e2e/jail-and-tree.spec.ts
      11 passed (12.4s)
