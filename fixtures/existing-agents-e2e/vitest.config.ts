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
    include: ["src/**/*.e2e.test.ts", "src/**/*.test.ts"],
    // Journeys pack the workspace once and boot real Next dev servers on fixed
    // ports: parallel files would race the pack cache and the ports.
    fileParallelism: false,
    // A journey is scaffold → npm install → vendo init → boot → live turn;
    // installs and first compiles dominate.
    testTimeout: 20 * 60 * 1000,
    hookTimeout: 20 * 60 * 1000,
  },
});
