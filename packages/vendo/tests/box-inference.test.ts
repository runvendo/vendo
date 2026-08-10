import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
} from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import { inMemoryBoxFiles } from "@vendoai/apps/testing";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";

// The box's inference-door ladder (release-gap fix, 2026-07-20): explicit
// VENDO_INFERENCE_URL/KEY → BYO ANTHROPIC_API_KEY → VENDO_API_KEY via the
// console's Anthropic-compatible model gateway. Before the Cloud rung landed,
// a zero-key Cloud host provisioned billed machines whose in-box agent had no
// model (the box harness refuses: "the box has no inference endpoint" —
// The box's task door maps VENDO_INFERENCE_URL/KEY onto
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
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const ADA: Principal = { kind: "user", subject: "user_ada" };

/** The harness's control port, as `apps/src/box-agent.ts` fixes it. Spelled out
 *  rather than imported for the reason a real provider would: a sandbox adapter
 *  is on the other side of the seam and does not import our constants. */
const BOX_CONTROL_PORT = 8811;

const decoder = new TextDecoder();

/** An already-graduated SERVED app: its whole surface is the code in its box,
 *  so every edit of it goes to the in-box agent — and every box edit re-injects
 *  the CURRENT boundary env across the control port before the agent runs
 *  (`editServerViaBox`, apps/src/box-lane.ts). That push is the production path
 *  this suite reads the composition's assembled env off. The ref is the one this
 *  suite's fake sandbox hands back from `snapshot()`, so `resume()` is given a
 *  ref it really produced. */
const doc = (id = "app_box"): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Box app",
  ui: "http",
  machine: {
    snapshotRef: "fake:snap",
    provisionedAt: "2026-07-12T00:00:00.000Z",
  },
});

const json = (status: number, value: unknown) => ({
  status,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(value)),
});

/** A capture sandbox: records every boundary env pushed across the box's
 * control port, so the test can assert the machine env the composition
 * assembled. It speaks just enough of the harness's control protocol
 * (apps/src/box-agent.ts) for one edit task to start and finish. */
function captureSandbox(pushed: Array<Record<string, string>>): SandboxAdapter {
  const machine: SandboxMachine = {
    id: "fake_box",
    async request(request) {
      if (request.port === BOX_CONTROL_PORT) {
        if (request.path === "/agent/env") {
          const body = typeof request.body === "string"
            ? request.body
            : decoder.decode(request.body ?? new Uint8Array());
          pushed.push((JSON.parse(body) as { env: Record<string, string> }).env);
          return json(200, { ok: true });
        }
        if (request.path === "/agent/task") return json(202, { taskId: "boxtask_1" });
        if (request.path.startsWith("/agent/task/")) {
          return json(200, {
            status: "done",
            result: { ok: true, summary: "edited", filesChanged: [], testsRun: 0 },
          });
        }
      }
      // A box that declares no vendo.json — the manifest fold-in reads a 404 as
      // "this box declares no schedules and no egress", which is the truth here.
      if (request.path === "/vendo.json") return json(404, { error: "no manifest" });
      return { status: 200, headers: {}, body: new Uint8Array() };
    },
    async url() { return "https://fake_box.capture.test"; },
    async snapshot() { return "fake:snap"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
    // The seam's ONE in-memory implementation (@vendoai/apps/testing), so no
    // two fakes can drift over what reading a box file means.
    files: inMemoryBoxFiles(new Map()),
  };
  return {
    async create() { return machine; },
    async resume() { return machine; },
    async destroy() { /* released */ },
  };
}

/** Compose, edit the app's box through a real runtime door, and hand back the
 * boundary env the composition assembled for it. Every ladder rung starts
 * cleared ("" reads as unset) so a key in the runner's own environment can
 * never leak into a rung assertion. */
async function boxEnv(rungs: Record<string, string> = {}): Promise<Record<string, string>> {
  vi.stubEnv("VENDO_BASE_URL", "http://box-inference.test");
  // The in-box edit is a long-poll loop; this suite drives it without real time.
  vi.stubEnv("VENDO_BOX_EDIT_POLL_MS", "1");
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
  const pushed: Array<Record<string, string>> = [];
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => ADA,
    store,
    sandbox: captureSandbox(pushed),
  });
  const edited = await vendo.apps.edit("app_box", "Tighten the invoice copy", {
    principal: ADA,
    venue: "app",
    presence: "present",
    sessionId: "session_box_inference",
  });
  expect(edited.failure).toBeUndefined();
  expect(pushed).toHaveLength(1);
  return pushed[0]!;
}

describe("boxInference ladder (the in-box agent's model door)", () => {
  it("VENDO_API_KEY alone points the box at the Cloud model gateway", async () => {
    const env = await boxEnv({ VENDO_API_KEY: "vnd_cloud_key" });
    expect(env["VENDO_INFERENCE_URL"]).toBe("https://console.vendo.run/api/v1");
    expect(env["VENDO_INFERENCE_KEY"]).toBe("vnd_cloud_key");
    // The gateway serves the vendo model family; the box harness's raw
    // claude-* default would be grace-remapped server-side, so the Cloud rung
    // pins the flagship family name.
    expect(env["VENDO_INFERENCE_MODEL"]).toBe("vendo");
  });

  it("VENDO_INFERENCE_MODEL still picks the Cloud alias on the Cloud rung", async () => {
    const env = await boxEnv({
      VENDO_API_KEY: "vnd_cloud_key",
      VENDO_INFERENCE_MODEL: "vendo-strong",
    });
    expect(env["VENDO_INFERENCE_URL"]).toBe("https://console.vendo.run/api/v1");
    expect(env["VENDO_INFERENCE_MODEL"]).toBe("vendo-strong");
  });

  it("respects VENDO_CLOUD_URL as the gateway base for the Cloud rung", async () => {
    const env = await boxEnv({
      VENDO_API_KEY: "vnd_cloud_key",
      VENDO_CLOUD_URL: "https://cloud-gateway.test/",
    });
    expect(env["VENDO_INFERENCE_URL"]).toBe("https://cloud-gateway.test/api/v1");
    expect(env["VENDO_INFERENCE_KEY"]).toBe("vnd_cloud_key");
  });

  it("explicit VENDO_INFERENCE_URL/KEY beat every lower rung", async () => {
    const env = await boxEnv({
      VENDO_INFERENCE_URL: "https://own-gateway.test",
      VENDO_INFERENCE_KEY: "own_key",
      ANTHROPIC_API_KEY: "sk-ant-byo",
      VENDO_API_KEY: "vnd_cloud_key",
    });
    expect(env["VENDO_INFERENCE_URL"]).toBe("https://own-gateway.test");
    expect(env["VENDO_INFERENCE_KEY"]).toBe("own_key");
  });

  it("a BYO ANTHROPIC_API_KEY beats the Cloud rung", async () => {
    const env = await boxEnv({
      ANTHROPIC_API_KEY: "sk-ant-byo",
      VENDO_API_KEY: "vnd_cloud_key",
    });
    expect(env["VENDO_INFERENCE_URL"]).toBe("https://api.anthropic.com");
    expect(env["VENDO_INFERENCE_KEY"]).toBe("sk-ant-byo");
    // BYO keeps the box harness's own real-model default — no alias pin.
    expect(env["VENDO_INFERENCE_MODEL"]).toBeUndefined();
  });

  it("no key on any rung leaves the box without an inference door", async () => {
    const env = await boxEnv();
    expect(env["VENDO_INFERENCE_URL"]).toBeUndefined();
    expect(env["VENDO_INFERENCE_KEY"]).toBeUndefined();
  });
});
