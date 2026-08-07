import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Reserve an ephemeral free port so a concurrent lane never collides on the
 * Maple dev server. The OS hands back an unused port; a lane holds it only for
 * the length of its run. Same shape as `fixtures/integration-browser`.
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
// config and the Next child all agree on the SAME port — otherwise `baseURL`,
// `VENDO_BASE_URL` and the dev server diverge, and `DEMO_AUTOLOGIN` is
// host-bound so a divergence there costs the session cookie.
const port = Number(process.env.MAPLE_CONTEXT_E2E_PORT) || (await freePort());
process.env.MAPLE_CONTEXT_E2E_PORT = String(port);
const baseURL = `http://127.0.0.1:${port}`;

/**
 * The whole Shipment 1 context chain, proven in a real browser on Maple.
 *
 * Every turn here is a REAL model call on a REAL app, and several of them carry
 * a deliberately enormous message, so the budgets are minutes rather than
 * seconds. `TURN_MS` (e2e/maple.ts) is one turn's allowance and the test
 * timeout is the sum of a spec's turns plus boot slack — the test timeout stays
 * the hang detector, and no inner poll gets a budget the machine cannot meet.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "./e2e/test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 900_000,
  expect: { timeout: 30_000 },
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
    // Maple's own dev server, nothing simulated. `dev` runs `predev`
    // (`vendo sync . --no-ai`) first, which is what fills `.vendo/`.
    command: `pnpm --filter demo-bank dev --port ${port}`,
    cwd: packageRoot,
    // A PUBLIC prefix (src/proxy.ts), so readiness never depends on a session.
    url: `${baseURL}/maple/login`,
    reuseExistingServer: false,
    // `next dev`'s first compile of Maple is slow, and `predev` runs a full
    // extraction pass before it.
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NO_COLOR: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      // The one seam that names a harness (examples/demo-bank/src/vendo/proof-harness.ts).
      // This is how the tiny `contextWindowTokens` reaches the deployment.
      MAPLE_HARNESS: "context-e2e",
      // A SIBLING of `.next`, never a child: `next build` wipes its whole
      // distDir (CLAUDE.md). Its own dist dir is also its own dev-server lock,
      // so this never fights a developer's `pnpm dev`.
      MAPLE_DIST_DIR: ".next-context-e2e",
      // The ledger this suite reads back has to be the one this server writes.
      MAPLE_STORE: "local",
      // A real Auth.js session with no login form to drive. Host-bound, which
      // is why `VENDO_BASE_URL` must name the origin the browser actually hits.
      DEMO_AUTOLOGIN: "1",
      VENDO_BASE_URL: baseURL,
      AUTH_SECRET: "maple-context-e2e-secret",
    },
  }],
});
