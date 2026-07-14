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
    // The fixture e2e drives a real Next dev server; under a loaded CI runner
    // (the automations e2e boots its own server in parallel) first-compile
    // requests overrun vitest's 5s default.
    testTimeout: 30_000,
  },
});
