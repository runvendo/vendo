import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModel } from "ai";
import type { SandboxAdapter } from "@vendoai/apps";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";

// 0.4.4 defect C — the field host (Turbopack server bundle, no e2b install)
// had e2bInstalled() blanket-passing, so a stray E2B_API_KEY outranked the
// Cloud sandbox and the first build died in an unusable venue. This file pins
// the ADAPTER RULE's ladder against exactly that: an e2b the runtime cannot
// load is never selected. Cloud-audit fix 5 sharpened the answer — half a BYO
// sandbox is now a LOUD compose-time misconfig instead of a silent demotion to
// Cloud (or to the dark venue), so the operator learns at startup rather than
// at the first server-app build.
vi.mock("@vendoai/apps/e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vendoai/apps/e2b")>()),
  e2bInstalled: () => false,
}));

import { createVendo } from "./server.js";

const principal: Principal = { kind: "user", subject: "user_venue" };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-venue-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

async function venueFor(env: Record<string, string>, sandbox?: SandboxAdapter): Promise<unknown> {
  vi.stubEnv("E2B_API_KEY", "");
  vi.stubEnv("VENDO_API_KEY", "");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store: await tempStore(),
    ...(sandbox === undefined ? {} : { sandbox }),
  });
  const status = await vendo.handler(new Request("https://host.test/api/vendo/status"));
  return (await status.json() as { blocks: { sandbox: unknown } }).blocks.sandbox;
}

describe("venue ladder with an unloadable e2b SDK (0.4.4 defect C)", () => {
  it("resolves cloud for the exact 0.4.4 regression env shape (VENDO_API_KEY + ANTHROPIC_API_KEY, no E2B key)", async () => {
    expect(await venueFor({
      VENDO_API_KEY: "vnd_cloud_key",
      ANTHROPIC_API_KEY: "sk-ant-byo",
    })).toBe("cloud");
  });

  it("refuses to compose: an E2B_API_KEY without a loadable SDK is a misconfig, not a demotion to Cloud", async () => {
    await expect(venueFor({
      E2B_API_KEY: "e2b_leaked_from_shell",
      VENDO_API_KEY: "vnd_cloud_key",
      ANTHROPIC_API_KEY: "sk-ant-byo",
    })).rejects.toThrow("E2B_API_KEY is set but the e2b package is not installed");
  });

  it("names the exact fix rather than going dark when the SDK is unloadable and no Vendo key is set", async () => {
    await expect(venueFor({ E2B_API_KEY: "e2b_leaked_from_shell" }))
      .rejects.toThrow("install e2b, or unset E2B_API_KEY to use another sandbox");
  });

  it("treats a whitespace-only E2B_API_KEY as unset, the way doctor's check reads it", async () => {
    // environment() only strips "", so a stray-space value used to reach the
    // throw above while `vendo doctor` (which trims) reported no key set.
    expect(await venueFor({
      E2B_API_KEY: "   ",
      VENDO_API_KEY: "vnd_cloud_key",
      ANTHROPIC_API_KEY: "sk-ant-byo",
    })).toBe("cloud");
  });

  it("still lets an explicit sandbox: adapter win before any env check", async () => {
    expect(await venueFor(
      { E2B_API_KEY: "e2b_leaked_from_shell" },
      { create: async () => { throw new Error("never called"); } } as unknown as SandboxAdapter,
    )).toBe("custom");
  });
});
