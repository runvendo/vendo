import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: resolve(dir, "src"),
  testMatch: "layers/**/*.e2e.spec.ts",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: resolve(dir, "../.repos/.logs/playwright-report") }],
  ],
  use: {
    baseURL: process.env.CORPUS_E2E_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
});
