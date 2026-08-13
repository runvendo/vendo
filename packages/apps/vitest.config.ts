import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The two toolchains want two compilers in one process. The Node one
    // resolves `typescript` through `createRequire`, which no bundler alias can
    // touch, so it keeps getting the 5.x devDependency; the edge one IMPORTS
    // `typescript`, and its peer range is exactly 6.0.3 — the version its
    // vendored lib files were copied from. Anchored, so `typescript-eslint` and
    // friends are not rewritten by prefix.
    alias: [{ find: /^typescript$/, replacement: "typescript-6" }],
  },
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
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.test-util.{ts,tsx}",
      ],
      // Ratcheted line-coverage floor (ENG-255): set at/just below the measured
      // value so it can only rise. Regression below this fails CI.
      thresholds: { lines: 88 },
    },
    include: ["tests/**/*.test.ts"],
    // Generation/ladder/execution suites drive scripted models + a real PGlite
    // store; under CI cross-package parallelism they can starve past vitest's 5s
    // default. 15s absorbs the contention without masking a real hang.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
