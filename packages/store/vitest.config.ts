import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-util.{ts,tsx}"],
      // Ratcheted line-coverage floor (ENG-255): conservative — measured from the
      // stable subset (84.53%, excluding the flaky conformance suite and the
      // space-path-sensitive durability drill). CI runs the full suite (both
      // included) and comfortably exceeds this, so the floor only ratchets up.
      thresholds: { lines: 84 },
    },
    fileParallelism: false,
    // Dual-backend PGlite/Postgres CRUD + a SIGKILL durability drill; under CI
    // cross-package parallelism these can starve well past vitest's 5s default.
    // Fresh PGlite startup has reached ~90s on the shared CI runner while the
    // same conformance cases complete in ~2s on real Postgres, so leave enough
    // room for initialization contention without changing production behavior.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
