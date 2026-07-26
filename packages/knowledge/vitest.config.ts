import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-util.{ts,tsx}"],
      // No ratcheted threshold yet — this is the Stage 0 scaffold (ENG-355).
      // The line-coverage floor gets set the way the sibling packages do it
      // (at/just below the measured value, so it can only rise) once the
      // engines land in Stage 1/2.
    },
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
