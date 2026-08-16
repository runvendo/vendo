import { configDefaults, defineConfig } from "vitest/config";

/**
 * The suites that launch a real Chromium through `openBrowser`.
 *
 * CI installs no Playwright browsers — `release.yml` is the only workflow that
 * runs `playwright install`, and only for `@vendoai/ui` — and `ci.yml` says why:
 * headless CI mis-resolves `:focus-visible` and `light-dark()`, so browser runs
 * stay a LOCAL gate on purpose. These would therefore not fail on their findings
 * there, they would fail on a missing executable.
 *
 * So they are dropped where the browser is missing and nowhere else. `CI` is the
 * flag because CI is the environment that lacks the browsers, and because it is
 * already declared in turbo.json's `test`/`test:coverage` env list, so the cache
 * key knows which of the two sets a replayed run actually covered. Locally,
 * unset, every suite runs exactly as it did before.
 *
 * `diy.test.ts` is here for ONE test (`the page answers the way the prompt
 * promised`); its fifteen model-boundary tests ride along. Splitting that file
 * would let them run in CI too.
 */
const BROWSER_SUITES = [
  "tests/axis.test.ts",
  "tests/diy.test.ts",
  "tests/extraction.test.ts",
  "tests/font.test.ts",
  "tests/mount.test.ts",
  "tests/probe.test.ts",
  "tests/render.test.ts",
  "tests/seam.test.ts",
];

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
    exclude: [...configDefaults.exclude, ...(process.env.CI === undefined ? [] : BROWSER_SUITES)],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}"],
      // No floor. A ratchet is a number measured against the whole suite, and
      // this package's suite is two different sets depending on whether a
      // browser is there — a floor sized on one of them is a gate the other
      // fails for no finding.
    },
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
