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
    include: ["e2e/**/*.test.ts"],
    environment: "node",
    // Live model turns: 30s flaked twice in one day on model latency alone
    // (release runs for v0.4.0 and v0.4.1, issue #501). mastra-agent already
    // runs 60s; these turns compose a full agent first, so give them 120s.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
