import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-util.{ts,tsx}"],
      // Ratcheted floor, sized in LINES rather than points: 713 lines means one
      // point is ~7 lines, so 93 against a measured 94.24 READ like comfortable
      // slack while tolerating only 9 new uncovered lines — thinner than
      // telemetry's, and invisible in percent. 91 tolerates 24.
      thresholds: { lines: 91 },
    },
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
