import { defaultExclude, defineConfig } from "vitest/config";

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
      // ONE number over the whole package, deliberately. The per-glob entries
      // that used to sit beside it (src/apps, src/cli, src/core, src/core/apps,
      // src/sandbox, src/ui) were each a fold's incoming floor carried across so
      // a merge could not weaken a gate as a side effect; the folds are done, and
      // what they left behind was six numbers nobody could read off a run — the
      // text reporter prints one row per DIRECTORY and each of those globs spans
      // several, so the aggregate the threshold checked never appeared in the
      // log. A floor nobody can measure is a floor nobody can raise.
      //
      // 93 is measured: coverage-merge of run 33328955194, 94.51 global without
      // the CLI, blended with the CLI's own 93.57 (run 33318885615). Slack is on
      // purpose — a floor with no room is a floor everyone learns to bypass.
      //
      // Off inside a shard, which sees a fraction of the files: coverage-merge
      // replays the blobs and enforces this against the whole suite. The switch
      // is VITEST_SHARD rather than a `--coverage.thresholds.lines=0` override
      // because an override reaches exactly one key and silently stops covering
      // any floor added later.
      thresholds: process.env.VITEST_SHARD ? {} : { lines: 93 },
    },
    // Two environments in one package since the ui fold: everything composes the
    // Node stack except tests/ui, which renders React and needs a DOM. Projects
    // rather than per-file `@vitest-environment` pragmas — 167 files would carry
    // one, and a new ui test that forgot it would run green in the wrong realm.
    // `extends: true` so both inherit the resolve alias, the worker caps and the
    // timeouts above; coverage stays here, where it spans both.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          // `e2e/**` is Playwright's, and the exclusion is load-bearing: those
          // are `.spec.ts` files, which vitest's DEFAULT include matches. ui kept
          // them out with a narrow `include`; the fold moved them into a package
          // that has no such fence, and all 26 were collected and failed.
          exclude: [...defaultExclude, "tests/ui/**", "e2e/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["tests/ui/**/*.test.ts?(x)"],
          // Both files: the umbrella's telemetry mute, then the DOM-realm
          // bridge @vendoai/ui carried in.
          setupFiles: ["./vitest.setup.ts", "./tests/ui/setup.ts"],
        },
      },
    ],
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
