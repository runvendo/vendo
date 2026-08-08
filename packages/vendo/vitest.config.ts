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
      // Ratcheted line-coverage floor (ENG-255): set at/just below the measured
      // value so it can only rise. Regression below this fails CI.
      thresholds: { lines: 78 },
    },
    environment: "node",
    // No real telemetry from tests (see vitest.setup.ts).
    setupFiles: ["./vitest.setup.ts"],
    // Every umbrella test composes the full stack (createVendo → real PGlite
    // store + agent + guard + apps + automations) and, for the wire tests,
    // streams a turn end to end. Turbo runs this suite concurrently with every
    // other package's tests, so on a loaded CI runner these full-stack tests can
    // starve well past vitest's 5s default (≈11s local, ≈90s for the suite under
    // CI contention). 30s absorbs the contention without masking a real hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
