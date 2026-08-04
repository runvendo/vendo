import { defineConfig, devices } from "@playwright/test";

/** Round B's proof run: the shipped harness, on PORT 3227, with the specs kept
 *  outside packages/ui/e2e (Round A owns that directory this wave). */
const packageRoot = "/Users/yousefh/orca/workspaces/flowlet/ui-s1-fixdefects/packages/ui";
const port = 3227;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "/tmp/postcheck-b",
  testMatch: "**/*.spec.ts",
  outputDir: "/tmp/postcheck-b/results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["line"]],
  use: {
    baseURL,
    viewport: { width: 1_280, height: 900 },
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: undefined } }],
  webServer: [{
    command: `pnpm exec vite --config e2e/harness/vite.config.ts --host 127.0.0.1 --port ${port}`,
    cwd: packageRoot,
    url: `${baseURL}/page`,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { NO_COLOR: "1", VENDO_HARNESS_PORT: String(port) },
  }],
});
