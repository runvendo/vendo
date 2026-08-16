import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModel } from "ai";
import type { SandboxAdapter } from "@vendoai/apps";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";

// 0.4.4 defect C — the field host (Turbopack server bundle, no e2b install)
// had e2bInstalled() blanket-passing, so a stray E2B_API_KEY outranked the Cloud
// sandbox and the first build died in an unusable venue. Two answers were tried:
// blanket-pass, then a LOUD compose-time misconfig. The SELECTION LAW removes the
// question instead — E2B_API_KEY is a credential, not a rung, so no stray key can
// flip a deployment's venue in either direction.
//
// The unloadable-SDK mock stays as the TRIPWIRE for that: this is the field host's
// exact shape, and nothing in the composition path may consult installability any
// more. Re-introduce an env-driven e2b rung and every case below changes answer.
vi.mock("@vendoai/apps/e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vendoai/apps/e2b")>()),
  e2bInstalled: () => false,
}));

import { createVendo } from "../src/server.js";

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
    models: { default: {} as LanguageModel },
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

  it("resolves cloud with the SAME stray E2B_API_KEY added — the key does not select, so nothing changes", async () => {
    expect(await venueFor({
      E2B_API_KEY: "e2b_leaked_from_shell",
      VENDO_API_KEY: "vnd_cloud_key",
      ANTHROPIC_API_KEY: "sk-ant-byo",
    })).toBe("cloud");
  });

  it("goes dark rather than refusing when a stray E2B_API_KEY is the only key set", async () => {
    // The required breaking-change case: composing must SUCCEED and report the
    // dark venue. A tree-only host is fine here; a server-work attempt is what
    // reports sandbox-unavailable, one layer up.
    expect(await venueFor({ E2B_API_KEY: "e2b_leaked_from_shell" })).toBe(false);
  });

  it("reads a whitespace-only E2B_API_KEY the same as any other value: not a selector", async () => {
    expect(await venueFor({
      E2B_API_KEY: "   ",
      VENDO_API_KEY: "vnd_cloud_key",
      ANTHROPIC_API_KEY: "sk-ant-byo",
    })).toBe("cloud");
    expect(await venueFor({ E2B_API_KEY: "   " })).toBe(false);
  });

  it("still lets an explicit sandbox: adapter win before any env check", async () => {
    expect(await venueFor(
      { E2B_API_KEY: "e2b_leaked_from_shell" },
      { create: async () => { throw new Error("never called"); } } as unknown as SandboxAdapter,
    )).toBe("custom");
  });
});
