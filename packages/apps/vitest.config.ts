import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-util.{ts,tsx}"],
    },
    include: ["src/**/*.test.ts"],
    // Generation/ladder/execution suites drive scripted models + a real PGlite
    // store; under CI cross-package parallelism they can starve past vitest's 5s
    // default. 15s absorbs the contention without masking a real hang.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
