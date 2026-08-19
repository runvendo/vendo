import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Worker caps live in config, not only in the root scripts: a cap on a
    // command line applies only when someone types that command, so a bare
    // `npx vitest`, an IDE runner and a debug run all escape it. Env
    // (VITEST_MIN/MAX_FORKS, VITEST_MIN/MAX_THREADS) still wins, so CI is
    // unchanged. Both halves are required — vitest defaults the min to the CPU
    // count independently of the max, and a max-only cap makes Tinypool throw
    // before a single test runs.
    poolOptions: {
      forks: { minForks: 1, maxForks: 2 },
      threads: { minThreads: 1, maxThreads: 2 },
    },
    include: ["tests/**/*.e2e.test.ts"],
    // One pack, one scaffold, one dev server, shared by every assertion.
    fileParallelism: false,
    // The whole seam runs inside the beforeAll hook: pack → install → init →
    // typecheck → boot. Installs and Next's first compile dominate, and this
    // timeout is the ONLY hang detector in the suite — no poll inside it
    // carries a tighter wall-clock budget of its own.
    testTimeout: 20 * 60 * 1000,
    hookTimeout: 20 * 60 * 1000,
  },
});
