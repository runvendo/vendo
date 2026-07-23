import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
} from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "./server.js";

// The box's inference-door ladder (release-gap fix, 2026-07-20): explicit
// VENDO_INFERENCE_URL/KEY → BYO ANTHROPIC_API_KEY → VENDO_API_KEY via the
// console's Anthropic-compatible model gateway. Before the Cloud rung landed,
// a zero-key Cloud host provisioned billed machines whose in-box agent had no
// model (the box harness refuses: "the box has no inference endpoint" —
// Wave 8's agent-sdk.mjs maps VENDO_INFERENCE_URL/KEY onto
// ANTHROPIC_BASE_URL/API_KEY for the Claude Agent SDK).

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(prefix: string): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const ADA: Principal = { kind: "user", subject: "user_ada" };

const doc = (id = "app_box"): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Box app",
});

type SandboxSpec = Parameters<SandboxAdapter["create"]>[0];

/** A capture sandbox: records every create() spec so the test can assert the
 * machine env the composition assembled. */
function captureSandbox(specs: SandboxSpec[]): SandboxAdapter {
  const machine: SandboxMachine = {
    id: "fake_box",
    async request() { return { status: 200, headers: {}, body: new Uint8Array() }; },
    async url() { return "https://fake_box.capture.test"; },
    async snapshot() { return "fake:snap"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  return {
    async create(spec) {
      specs.push(spec);
      return machine;
    },
    async resume() { return machine; },
    async destroy() { /* released */ },
  };
}

/** Compose, provision, and hand back the env the sandbox saw at create.
 * Every ladder rung starts cleared ("" reads as unset) so a key in the
 * runner's own environment can never leak into a rung assertion. */
async function provisionedEnv(rungs: Record<string, string> = {}): Promise<Record<string, string>> {
  vi.stubEnv("VENDO_BASE_URL", "http://box-inference.test");
  for (const name of ["VENDO_INFERENCE_URL", "VENDO_INFERENCE_KEY", "VENDO_INFERENCE_MODEL", "ANTHROPIC_API_KEY", "VENDO_API_KEY", "VENDO_CLOUD_URL"]) {
    vi.stubEnv(name, rungs[name] ?? "");
  }
  const store = await tempStore("vendo-box-inference-");
  await store.ensureSchema();
  await store.records("vendo_apps").put({
    id: "app_box",
    data: { subject: ADA.subject, enabled: false, doc: doc() },
    refs: { subject: ADA.subject },
  });
  const specs: SandboxSpec[] = [];
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => ADA,
    store,
    sandbox: captureSandbox(specs),
    // Wave 9 — machine provisioning is flag-gated.
    apps: { experimentalMachines: true },
  });
  await vendo.apps.machine.provision("app_box", {
    principal: ADA,
    venue: "app",
    presence: "present",
    sessionId: "session_box_inference",
  });
  expect(specs).toHaveLength(1);
  return specs[0]!.env;
}

describe("boxInference ladder (the in-box agent's model door)", () => {
  it("VENDO_API_KEY alone points the box at the Cloud model gateway", async () => {
    const env = await provisionedEnv({ VENDO_API_KEY: "vnd_cloud_key" });
    expect(env["VENDO_INFERENCE_URL"]).toBe("https://console.vendo.run/api/v1");
    expect(env["VENDO_INFERENCE_KEY"]).toBe("vnd_cloud_key");
    // The gateway serves the vendo model family; the box harness's raw
    // claude-* default would be grace-remapped server-side, so the Cloud rung
    // pins the flagship family name.
    expect(env["VENDO_INFERENCE_MODEL"]).toBe("vendo");
  });

  it("VENDO_INFERENCE_MODEL still picks the Cloud alias on the Cloud rung", async () => {
    const env = await provisionedEnv({
      VENDO_API_KEY: "vnd_cloud_key",
      VENDO_INFERENCE_MODEL: "vendo-strong",
    });
    expect(env["VENDO_INFERENCE_URL"]).toBe("https://console.vendo.run/api/v1");
    expect(env["VENDO_INFERENCE_MODEL"]).toBe("vendo-strong");
  });

  it("respects VENDO_CLOUD_URL as the gateway base for the Cloud rung", async () => {
    const env = await provisionedEnv({
      VENDO_API_KEY: "vnd_cloud_key",
      VENDO_CLOUD_URL: "https://cloud-gateway.test/",
    });
    expect(env["VENDO_INFERENCE_URL"]).toBe("https://cloud-gateway.test/api/v1");
    expect(env["VENDO_INFERENCE_KEY"]).toBe("vnd_cloud_key");
  });

  it("explicit VENDO_INFERENCE_URL/KEY beat every lower rung", async () => {
    const env = await provisionedEnv({
      VENDO_INFERENCE_URL: "https://own-gateway.test",
      VENDO_INFERENCE_KEY: "own_key",
      ANTHROPIC_API_KEY: "sk-ant-byo",
      VENDO_API_KEY: "vnd_cloud_key",
    });
    expect(env["VENDO_INFERENCE_URL"]).toBe("https://own-gateway.test");
    expect(env["VENDO_INFERENCE_KEY"]).toBe("own_key");
  });

  it("a BYO ANTHROPIC_API_KEY beats the Cloud rung", async () => {
    const env = await provisionedEnv({
      ANTHROPIC_API_KEY: "sk-ant-byo",
      VENDO_API_KEY: "vnd_cloud_key",
    });
    expect(env["VENDO_INFERENCE_URL"]).toBe("https://api.anthropic.com");
    expect(env["VENDO_INFERENCE_KEY"]).toBe("sk-ant-byo");
    // BYO keeps the box harness's own real-model default — no alias pin.
    expect(env["VENDO_INFERENCE_MODEL"]).toBeUndefined();
  });

  it("no key on any rung leaves the box without an inference door", async () => {
    const env = await provisionedEnv();
    expect(env["VENDO_INFERENCE_URL"]).toBeUndefined();
    expect(env["VENDO_INFERENCE_KEY"]).toBeUndefined();
  });
});
