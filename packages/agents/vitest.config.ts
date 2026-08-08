import { defineConfig } from "vitest/config";
import { workerCaps } from "../../vitest.shared.js";

export default defineConfig({
  test: {
    ...workerCaps,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.test-util.{ts,tsx}"],
      // Ratcheted floor, sibling-package style — set just below measured; it can only rise.
      thresholds: { lines: 93 },
    },
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
