import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    environment: "node",
    // Live model turns: 30s flaked twice in one day on model latency alone
    // (release runs for v0.4.0 and v0.4.1, issue #501). mastra-agent already
    // runs 60s; these turns compose a full agent first, so give them 120s.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
