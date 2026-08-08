import { defineConfig } from "vitest/config";
import { workerCaps } from "../../vitest.shared.js";

export default defineConfig({
  test: {
    ...workerCaps,
    include: ["src/**/*.test.ts"],
    // The approval block waits on real timers up to APPROVAL_WAIT_MS; the
    // timeout tests drive it with a shrunk wait, but cross-package CI
    // parallelism still starves vitest's 5s default.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
