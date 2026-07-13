import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Reserve an ephemeral free port so concurrent hardening lanes never collide on
 * the harness dev server. The OS hands back an unused port; a lane holds it only
 * for the length of its run.
 */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

// Reserve once, then pin into the environment so every re-evaluation of this
// config (Playwright re-imports it per worker) and the vite child all agree on
// the SAME port — otherwise baseURL and the dev server diverge.
const port = Number(process.env.VENDO_HARNESS_PORT) || (await freePort());
process.env.VENDO_HARNESS_PORT = String(port);
const baseURL = `http://127.0.0.1:${port}`;

/** 08-ui §4–5 — deterministic Chromium journey over the REAL composed umbrella. */
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
    baseURL,
    viewport: { width: 1_280, height: 900 },
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    screenshot: "off",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: undefined } }],
  webServer: [{
    command: `pnpm exec vite --config e2e/harness/vite.config.ts --host 127.0.0.1 --port ${port}`,
    cwd: packageRoot,
    url: baseURL,
    reuseExistingServer: false,
    // The vite child boots the fixture host app (next dev, first compile) AND the
    // composed umbrella before it listens — give it room.
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { NO_COLOR: "1", VENDO_HARNESS_PORT: String(port) },
  }],
});
