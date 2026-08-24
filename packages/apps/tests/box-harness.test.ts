import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
// The box harness ships as zero-dependency runtime .mjs baked into the base
// template; it is exercised here through its side-effect-free factory.
import { createHarness } from "../box/harness.mjs";

/** The control port answers JSON; `Response.json()` hands back `unknown`, so
 *  each read names the shape the route documents. */
const jsonOf = async <T>(response: Response): Promise<T> => await response.json() as T;

/**
 * A temp dir removed when the test finishes — pass, fail, or throw.
 * `onTestFinished` runs outside the test body, so a harness that fails to
 * start (or an assertion that throws mid-test) cannot strand the directory.
 */
function boxDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Poll until `ready()`. The test's OWN timeout is the only bound, deliberately:
 * `bash -lc` startup varies wildly under turbo-parallel load, and an inner
 * wall-clock deadline is a second, invisible speed limit — when it expires
 * first the case fails on the trailing assertion ("expected 'ran'"), which
 * reads as a product bug on a machine that was merely busy. A timeout is the
 * hang detector; there is only ever one of them.
 */
const pollUntil = async (ready: () => boolean): Promise<void> => {
  while (!ready()) await new Promise((resolve) => setTimeout(resolve, 100));
};

/** Drive one harness on an ephemeral port. */
const withHarness = async (
  body: (base: string, harness: ReturnType<typeof createHarness>) => Promise<void>,
): Promise<void> => {
  const appDir = boxDir("vendo-box-");
  const harness = createHarness({
    appDir,
    controlPort: 0,
    baseEnv: { VENDO_INFERENCE_URL: "http://model.test", VENDO_INFERENCE_KEY: "k" },
  });
  await harness.start();
  const address = harness.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await body(`http://127.0.0.1:${port}`, harness);
  } finally {
    await harness.stop();
  }
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("box control-port protocol", () => {
  it("reports health", async () => {
    await withHarness(async (base) => {
      const response = await fetch(`${base}/agent/health`);
      expect(response.status).toBe(200);
      const body = await jsonOf<{ ok: boolean; harness: string }>(response);
      expect(body.ok).toBe(true);
      expect(body.harness).toBe("vendo-box/1");
    });
  });

  it("supervises the app from the .vendo/run Procfile entry", async () => {
    const appDir = boxDir("vendo-box-");
    const marker = path.join(appDir, "started.txt");
    // createHarness() creates .vendo/; write the Procfile entry before start().
    const harness = createHarness({ appDir, controlPort: 0 });
    cleanups.push(() => harness.stop());
    writeFileSync(path.join(appDir, ".vendo", "run"), `printf ran > ${JSON.stringify(marker)}; sleep 30`);
    await harness.start();
    // The supervisor spawns the entry on start; the happy path exits on the
    // first sighting.
    await pollUntil(() => {
      try {
        return readFileSync(marker, "utf8") === "ran";
      } catch {
        return false; // Not written yet.
      }
    });
    expect(readFileSync(marker, "utf8")).toBe("ran");
  }, 30_000);

  it("spawns the Procfile entry without login-shell profiles (the Wave-6 load flake, and an env leak)", async () => {
    // Wave 7 H2 item 4 — a Procfile entry is ONE shell line, not a login: the
    // supervisor must never source the machine's shell profiles. Sourcing them
    // is what flaked this suite under load-average 40 (a host ~/.bash_profile
    // is arbitrarily slow), and it leaks host profile env into the app.
    const appDir = boxDir("vendo-box-");
    const home = boxDir("vendo-home-");
    const profileRan = path.join(home, "profile-ran");
    writeFileSync(
      path.join(home, ".bash_profile"),
      `export VENDO_PROFILE_LEAK=yes\ntouch ${JSON.stringify(profileRan)}\n`,
    );
    const marker = path.join(appDir, "started.txt");
    const harness = createHarness({ appDir, controlPort: 0, baseEnv: { HOME: home } });
    cleanups.push(() => harness.stop());
    writeFileSync(path.join(appDir, ".vendo", "run"), `printf %s "$VENDO_PROFILE_LEAK" > ${JSON.stringify(marker)}; sleep 30`);
    await harness.start();
    await pollUntil(() => existsSync(marker));
    // The entry ran with NO profile sourced: no leaked env, no profile side
    // effects — and none of the profile's latency on the spawn path.
    expect(readFileSync(marker, "utf8")).toBe("");
    expect(existsSync(profileRan)).toBe(false);
  }, 30_000);
});
