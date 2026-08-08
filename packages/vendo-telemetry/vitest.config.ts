import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-util.{ts,tsx}"],
      // Ratcheted line-coverage floor (ENG-255), sized in LINES rather than
      // points: this package is only 422 lines, so one point is ~4 lines and a
      // floor of 98 tolerated 8 new uncovered lines even with coverage at
      // 100.00% — less than one feature's worth of never-throw catch blocks,
      // which is what every uncovered line here has ever been. 95 tolerates 22.
      // Lines are at 100.00%, so deleting covered code can no longer move the
      // ratio at all — the denominator-shrink failure is off the table here.
      thresholds: { lines: 95 },
    },
  },
});
