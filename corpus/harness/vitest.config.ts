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
      // No floor: the ratcheted gate covered only the knowledge-eval module,
      // now removed, and no other module has a measured coverage history.
      // CI still runs this package through test:coverage (test-rest group-b),
      // so a floor can join here the day a module measures one.
    },
    environment: "node",
    // The harness exercises real git repositories and process trees. Those
    // tests can exceed Vitest's 5s default when Turbo runs every workspace in
    // parallel, even though the operations themselves are bounded.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
