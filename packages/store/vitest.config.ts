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
      // Ratcheted line-coverage floor (ENG-255): conservative — measured from the
      // stable subset (84.53%, excluding the flaky conformance suite and the
      // space-path-sensitive durability drill). CI runs the full suite (both
      // included) and comfortably exceeds this, so the floor only ratchets up.
      thresholds: { lines: 84 },
    },
    fileParallelism: false,
    // Dual-backend PGlite/Postgres CRUD + a SIGKILL durability drill; under CI
    // cross-package parallelism these can starve well past vitest's 5s default.
    // Fresh PGlite startup has reached ~90s on the shared CI runner while the
    // same conformance cases complete in ~2s on real Postgres, so leave enough
    // room for initialization contention without changing production behavior.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
