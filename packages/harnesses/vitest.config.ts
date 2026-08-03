import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The approval block waits on real timers up to APPROVAL_WAIT_MS; the
    // timeout tests drive it with a shrunk wait, but cross-package CI
    // parallelism still starves vitest's 5s default.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
