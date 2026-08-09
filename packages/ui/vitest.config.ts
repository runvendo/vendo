import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Worker caps live in config, not in the root `test` scripts: a cap in a
    // command line only applies when someone types that command, so a bare
    // `npx vitest`, an IDE runner and a debug run all escaped it. Env
    // (VITEST_MIN/MAX_FORKS, VITEST_MIN/MAX_THREADS) still wins, so CI is
    // unchanged. Both halves are required: vitest 2.1 defaults the min to the
    // CPU count independently of the max, and a max-only cap makes Tinypool
    // throw `minThreads and maxThreads must not conflict` before any test runs.
    poolOptions: {
      forks: { minForks: 1, maxForks: 2 },
      threads: { minThreads: 1, maxThreads: 2 },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-util.{ts,tsx}"],
      // Line-coverage floor (ENG-255). CI enforces it in the coverage-merge job,
      // against the whole suite's merged coverage rather than any single shard.
      // RATCHET — this number only ever rises: when it goes red, add coverage,
      // never lower the floor.
      // Last set 2026-08-08 to 90, against a measured 91.65% lines (11509/12557)
      // on main — re-measured through the merge path after the undo/rollback
      // deletion and four ui fixes landed. The 1.65 points of slack are
      // deliberate: a floor with no room is a floor everyone learns to bypass.
      // Branches are not floored (88.86% when this was set).
      thresholds: { lines: 90 },
    },
    environment: "jsdom",
    include: ["test/**/*.test.ts?(x)"],
    setupFiles: ["test/setup.ts"],
    // Flake floor for the chrome streaming suite. These tests drive a turn and
    // then await streamed UI (the sidebar refresh, the retry banner, "Turn
    // complete"), each guarded by its own generous `waitFor`/`findBy` window.
    // Under the CI coverage (v8) job those settles legitimately run past
    // vitest's 5s default testTimeout, so the per-test cap — not the inner
    // waits — was killing them ("Unable to find role=button 'Fixture thread' /
    // 'Retry'"). A test cap comfortably above the inner waits lets those
    // windows actually apply; passing tests still resolve the instant their
    // condition is met, so this only adds headroom under load.
    testTimeout: 30000,
    // Same headroom for hooks: the embeds suite's afterEach unmounts components
    // with live poll timers against the fake wire, and under the CI coverage
    // job that cleanup ran past vitest's 10s default hookTimeout ("Hook timed
    // out in 10000ms"), leaving stale DOM that cascaded duplicate-element
    // failures into the NEXT test. Hooks that finish fast are unaffected.
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      // Resolve `fluidkit` to an inert stub in EVERY ui test, so no test worker
      // ever loads the real decorative animation library (or its `motion`
      // peer). Two flake hazards this removes package-wide:
      //   1. motion's frameloop keeps a rAF outstanding; under jsdom that rAF is
      //      a Node `setInterval` that survives vitest's environment teardown
      //      and dereferences a stripped `window` -> unhandled "window is not
      //      defined".
      //   2. The first dynamic import triggers vite's in-worker transform of the
      //      fluidkit+motion chunk (multi-second on loaded CI), stalling the
      //      worker past `findBy*` windows and timing out unrelated assertions.
      // fluidkit is not under test in this package; the stub is faithful (the
      // presence is decorative and `aria-hidden`). See test/mocks/fluidkit.tsx.
      fluidkit: fileURLToPath(new URL("./test/mocks/fluidkit.tsx", import.meta.url)),
    },
  },
});
