import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { npmLatestVersion } from "../../src/cli/dep-versions.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { CLI_VERSION, type Output } from "../../src/cli/shared.js";

/**
 * Self-serve audit F1: npm release-cooldown configs (`min-release-age`)
 * resolve an old @vendoai/vendo silently — one gauntlet install sat four
 * versions and seven days behind with nothing ever saying so. Doctor now says
 * it, and says nothing at all when the registry cannot be reached.
 */

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sink(): { errors: string[]; output: Output } {
  const errors: string[] = [];
  return { errors, output: { log: () => {}, error: (message) => errors.push(message) } };
}

/** The smallest host doctor will run against: nothing here reaches a network
    except the npm lookup under test (which every case scripts). */
async function host(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-doctor-skew-"));
  cleanup.push(root);
  await mkdir(join(root, ".vendo"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@vendoai/vendo": CLI_VERSION } }));
  return root;
}

async function doctorErrors(npmLatest: () => Promise<string | null>): Promise<string> {
  const messages = sink();
  await runDoctor({
    targetDir: await host(),
    env: {},
    interactive: false,
    fetchImpl: vi.fn(async () => { throw new Error("connection refused"); }),
    liveTurn: async () => ({ attempted: false, ok: false, rung: "none", credential: "none", elapsedMs: 0 }),
    cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
    telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    output: messages.output,
    npmLatest,
  });
  return messages.errors.join("\n");
}

describe("doctor names an install that is behind npm latest", () => {
  it("stale: names both versions, the upgrade command, and why it happened", async () => {
    const errors = await doctorErrors(async () => "99.0.0");
    expect(errors).toContain(`warning: installed @vendoai/vendo ${CLI_VERSION} is behind latest 99.0.0`);
    expect(errors).toContain("npm install @vendoai/vendo@latest");
    expect(errors).toContain("min-release-age");
  });

  it("current: silent when the installed version IS latest", async () => {
    expect(await doctorErrors(async () => CLI_VERSION)).not.toContain("is behind latest");
  });

  it("offline: silent when the registry cannot answer", async () => {
    expect(await doctorErrors(async () => null)).not.toContain("is behind latest");
  });

  it("never warns backwards — a prerelease CLI ahead of latest stays quiet", async () => {
    expect(await doctorErrors(async () => "0.0.1")).not.toContain("is behind latest");
  });
});

describe("the npm latest lookup fails soft", () => {
  it("reads the dist-tag document", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ latest: "1.2.3", next: "2.0.0-rc.1" }));
    expect(await npmLatestVersion("@vendoai/vendo", fetchImpl as unknown as typeof fetch)).toBe("1.2.3");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://registry.npmjs.org/-/package/@vendoai/vendo/dist-tags");
  });

  it("answers null for a throwing fetch, a non-2xx, and a shapeless body", async () => {
    const throws = vi.fn(async () => { throw new Error("ENOTFOUND"); });
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    const shapeless = vi.fn(async () => Response.json({ tags: {} }));
    for (const impl of [throws, notFound, shapeless]) {
      expect(await npmLatestVersion("@vendoai/vendo", impl as unknown as typeof fetch)).toBeNull();
    }
  });
});
