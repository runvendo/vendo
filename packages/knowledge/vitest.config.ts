import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-util.{ts,tsx}"],
      // Ratchet set with the engines (ENG-361..365) just below the measured
      // 96.8% lines, sibling-package style — it can only rise.
      thresholds: { lines: 96 },
    },
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
