import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The fixture e2e drives a real Next dev server; under a loaded CI runner
    // (the automations e2e boots its own server in parallel) first-compile
    // requests overrun vitest's 5s default.
    testTimeout: 30_000,
  },
});
