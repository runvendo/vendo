import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

/** 08-ui §4–5 — deterministic Chromium verification over the localhost wire fixture. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "./e2e/test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_500 },
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1_280, height: 900 },
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    screenshot: "off",
    trace: "retain-on-failure",
  },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      channel: undefined,
      // A synthetic mic + auto-granted permission: the live voice smoke
      // (e2e/live/, OPENAI_API_KEY-gated) needs real getUserMedia, and the
      // deterministic suite is unaffected by an unused fake device.
      launchOptions: {
        args: [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          "--autoplay-policy=no-user-gesture-required",
        ],
      },
      permissions: ["microphone"],
    },
  }],
  webServer: [{
    command: "pnpm exec vite --config e2e/harness/vite.config.ts --host 127.0.0.1 --port 4173",
    cwd: packageRoot,
    url: "http://127.0.0.1:4173/thread",
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { NO_COLOR: "1" },
  }],
});
