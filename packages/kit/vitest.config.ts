import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}"],
    },
    environment: "jsdom",
    include: ["test/**/*.test.ts?(x)"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
