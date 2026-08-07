import { defineConfig, devices } from "@playwright/test";

/** Self-contained MCP Apps check; unlike the full UI suite it needs no fixture server. */
export default defineConfig({
  testDir: ".",
  testMatch: "mcp-shim.spec.ts",
  outputDir: "./test-results/mcp-shim",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_500 },
  reporter: [["line"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1_280, height: 900 },
    screenshot: "off",
    trace: "retain-on-failure",
  },
});
