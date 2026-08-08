/**
 * Worker caps, shared by every package's vitest config.
 *
 * These live in CONFIG, not in the root `test` scripts, because a cap that
 * lives in a command line only applies when someone types that command. The
 * root scripts set `VITEST_MIN_FORKS`/`MAX_FORKS` and the THREADS pair, so
 * `pnpm test` and CI are capped — but `pnpm --filter <pkg> test`, a bare
 * `npx vitest`, an IDE runner and a debug run all bypass them, and vitest then
 * sizes its pool to the CPU count. That is how a 12-core laptop ends up with
 * ~27 vitest workers: each package's pool is sized independently, and the
 * PGlite suites boot an embedded Postgres per worker. Config is the one layer
 * every entry path goes through.
 *
 * The env vars still WIN where they are set: vitest applies them over the
 * resolved config (`resolveConfig`, the `process.env.VITEST_*` block), so CI's
 * job-level values continue to override these and nothing about CI changes.
 *
 * The MIN half is not optional. vitest 2.1 defaults `minThreads`/`minForks` to
 * the CPU count independently of the max, so a max-only cap makes Tinypool
 * throw `minThreads and maxThreads must not conflict` before a single test
 * runs. Set both halves, for both pool types, or neither.
 */
export const workerCaps = {
  poolOptions: {
    forks: { minForks: 1, maxForks: 2 },
    threads: { minThreads: 1, maxThreads: 2 },
  },
} as const;
