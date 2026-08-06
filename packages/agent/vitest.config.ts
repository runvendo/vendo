import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-util.{ts,tsx}"],
      // Ratcheted line-coverage floor (ENG-255): set at/just below the measured
      // value so it can only rise. Regression below this fails CI.
      // Re-ratcheted after the S4 engine fold moved the high-coverage modules
      // (pack/tools/loop/tool-search/...) out to @vendoai/harnesses; no
      // surviving file's own coverage dropped, only the mix changed.
      thresholds: { lines: 92 },
    },
  },
});
