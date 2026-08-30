import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The two toolchains want two compilers in one process. The Node one
    // resolves `typescript` through `createRequire`, which no bundler alias can
    // touch, so it keeps getting the 5.x devDependency; the edge one IMPORTS
    // `typescript`, and its peer range is exactly 6.0.3 — the version its
    // vendored lib files were copied from. Anchored, so `typescript-eslint` and
    // friends are not rewritten by prefix. (Arrived with the apps fold, S11d;
    // scripts/portability-gate.mjs's edge leg aliases the same pair.)
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
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-util.{ts,tsx}"],
      // Ratcheted line-coverage floor (ENG-255): set at/just below the measured
      // value so it can only rise. Regression below this fails CI.
      //
      // A glob entry is an ADDITIVE check, never an exclusion: its files are
      // held to the glob AND go on counting in the global number. That is why
      // the CLI fold parked src/cli/ in `exclude` instead of handing it a glob
      // of 0 — an exclusion was the only thing that could keep the then-78
      // global measuring its pre-fold file set. This is the re-ratchet that
      // exclusion was placed for, so src/cli/ comes back in with a floor.
      //
      // Measured on main, coverage-merge of run 33328955194 (the fold commit),
      // 94.51 global without the CLI; the CLI itself last measured 93.57 as
      // @vendoai/cli in run 33318885615, one commit earlier, over a src/ whose
      // 71 files and 66 test files the fold moved across unchanged. A 93.57
      // sixth of the tree blended into a 94.51 rest cannot land below 93.57, so
      // the global goes 78 -> 93 and the CLI takes 92 — each keeping the point
      // or so of slack the ui floor argues for: a floor with no room is a floor
      // everyone learns to bypass.
      //
      // src/apps/** and src/sandbox/** are the app-generation code S11d folded
      // in, held at the 88 it arrived with so a fold cannot weaken a gate as a
      // side effect. They do NOT re-ratchet here: the text reporter prints one
      // row per directory and each of those globs spans several, so the
      // aggregate the threshold actually checks never appears in the log. They
      // rise when someone measures them, not before.
      //
      // Off inside a shard, which sees a fraction of the files: coverage-merge
      // replays the blobs and enforces these against the whole suite. This gate
      // lives here rather than in a CLI override because
      // `--coverage.thresholds.lines=0` reaches only the top-level key — the
      // per-glob entries kept their 88 and reddened all eight shards the day
      // S11d added them, with every test passing.
      thresholds: process.env.VITEST_SHARD
        ? {}
        : {
            lines: 93,
            "src/apps/**": { lines: 88 },
            "src/cli/**": { lines: 92 },
            "src/sandbox/**": { lines: 88 },
          },
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
