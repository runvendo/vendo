import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Scoped to the knowledge-eval module: the pre-existing ~3k-line
      // harness joined CI without a coverage history, so a whole-src floor
      // would either be meaninglessly low or force rewriting history. The
      // ratchet gates what this gate was added for; widen the include (and
      // re-measure the floor) when other modules want in.
      include: ["src/knowledge-eval/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.test-util.ts", "src/**/*.live.test.ts"],
      // Ratcheted line-coverage floor (guard convention): set at/just below
      // the measured value (98.98 at introduction) so it can only rise;
      // regression fails CI.
      thresholds: { lines: 98 },
    },
    environment: "node",
    // The harness exercises real git repositories and process trees. Those
    // tests can exceed Vitest's 5s default when Turbo runs every workspace in
    // parallel, even though the operations themselves are bounded.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
