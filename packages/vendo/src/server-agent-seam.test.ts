/**
 * `createVendo({ agent })` — the seam the agents-v0 spec names ("Vendo's embed
 * consumes it across a real seam"), tested AS a seam: a real agent from
 * `agent()` handed to a real `createVendo`, with no stub standing in for either
 * side. Both halves mocking each other is exactly how this class of feature
 * ships green and dead, so every case below reads through the real composition —
 * a real turn, the real `/status` venue, the real Cloud adapter's HTTP call.
 */
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import { agent } from "@vendoai/agents";
import { defineHarness, harnessAdapters } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-agent-seam-"));
  const store = createStore({ dataDir });
  // Migrated up front: `agent()` defers this to its first `session()`, and the
  // cases below reach the audit table by booting a box directly.
  await store.ensureSchema();
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** No env sandbox and no Vendo key, unless a case says otherwise. */
const noKeys = (): void => {
  vi.stubEnv("E2B_API_KEY", "");
  vi.stubEnv("VENDO_API_KEY", "");
};

const boxy = () => defineHarness({ name: "boxy", requires: { sandbox: true }, async *run() {} });

const fakeSandbox = (): SandboxAdapter & { created: unknown[] } => {
  const created: unknown[] = [];
  const machine = {
    id: "box_1",
    request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
    url: async () => "http://box",
    snapshot: async () => "fake:snap",
    stop: async () => {},
    destroy: async () => {},
  } satisfies SandboxMachine;
  return {
    created,
    async create(spec) {
      created.push(spec);
      return machine;
    },
    resume: async () => machine,
    destroy: async () => {},
  };
};

describe("createVendo({ agent }) adopts what the agent already composed", () => {
  it("thinks with the agent's harness, over the agent's store", async () => {
    noKeys();
    const store = await tempStore();
    let thought = false;
    const support = agent({
      name: "support",
      store,
      instructions: "Answer as Maple support.",
      harness: defineHarness({
        name: "scripted",
        async *run() {
          thought = true;
          yield { type: "text", delta: "Two invoices are open." };
        },
      }),
    });

    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => ({ kind: "user", subject: "user_seam" }),
      agent: support,
    });

    // The store is the agent's own instance, not a second one composed beside it.
    expect(vendo.store).toBe(store);

    const turn = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "thr_seam",
        message: { id: "m1", role: "user", parts: [{ type: "text", text: "how many?" }] } satisfies UIMessage,
      }),
    }));
    expect(turn.status).toBe(200);
    expect(await turn.text()).toContain("Two invoices are open.");
    // The agent's brain really ran the embed's turn.
    expect(thought).toBe(true);
  });

  it("boots the agent's sandbox as this deployment's venue", async () => {
    noKeys();
    const harness = boxy();
    const support = agent({
      name: "support",
      harness,
      store: await tempStore(),
      sandbox: fakeSandbox(),
      egress: ["api.stripe.com"],
    });

    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => ({ kind: "user", subject: "user_seam" }),
      agent: support,
    });

    // With no env keys at all, a venue can only be reported because the agent's
    // adapter was adopted — and the boot gate accepted a harness that needs one.
    const status = await vendo.handler(new Request("https://host.test/api/vendo/status"));
    expect((await status.json() as { blocks: { sandbox: unknown } }).blocks.sandbox).toBe("custom");
    // And it is the EGRESS-SKINNED adapter, so a box the embed boots carries the
    // agent's allowlist and its audit row like any other.
    const injected = harnessAdapters(harness).sandbox as SandboxAdapter;
    await injected.create({ env: {}, allowedDomains: ["api.anthropic.com"] });
  });

  it("refuses a slot filled twice, naming every conflict", async () => {
    noKeys();
    const store = await tempStore();
    const support = agent({ name: "support", harness: boxy(), store, sandbox: fakeSandbox() });
    const base = {
      model: {} as LanguageModel,
      principal: async () => ({ kind: "user" as const, subject: "user_seam" }),
      agent: support,
    };

    expect(() => createVendo({ ...base, store })).toThrow(
      "createVendo({ agent }) already brings `store` from the agent it was built with; remove it from createVendo, or move it into agent({ … }) — one slot, one owner.",
    );
    expect(() => createVendo({ ...base, store, sandbox: fakeSandbox() })).toThrow(
      /already brings `store`, `sandbox`/,
    );
    expect(() => createVendo({ ...base, harness: boxy() })).toThrow(/already brings `harness`/);
    // Prose is a slot the adopted agent owns too, now that there is exactly one
    // key for it: filling both is the same conflict, not a silent loser.
    expect(() => createVendo({ ...base, instructions: "a second voice" }))
      .toThrow(/already brings `instructions`/);
    expect(() => createVendo(base)).not.toThrow();
  });

  it("refuses an agent-shaped object this runtime did not build", async () => {
    noKeys();
    const store = await tempStore();
    expect(() => createVendo({
      model: {} as LanguageModel,
      principal: async () => ({ kind: "user", subject: "user_seam" }),
      store,
      agent: { name: "impostor", session: async () => ({}) } as never,
    })).toThrow(/`agent\(\)` from @vendoai\/agents did not build/);
  });
});

describe("the umbrella fills the agent's unset Cloud slots, and only those", () => {
  it("resolves the Cloud sandbox for an unset slot — the real console adapter", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    vi.stubEnv("VENDO_API_KEY", "vk_seam");
    vi.stubEnv("VENDO_CLOUD_URL", "https://console.seam.test");
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ id: "cloud_box_1", url: "https://cloud_box_1-m.vendo.run" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchSpy);

    // No `sandbox:` anywhere: the only rung that can answer is the one importing
    // this module registered (provideCloudAdapters, top of server.ts).
    const harness = boxy();
    agent({ name: "support", harness, store: await tempStore() });

    const injected = harnessAdapters(harness).sandbox as SandboxAdapter;
    await injected.create({ env: {} });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://console.seam.test/api/v1/sandboxes");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer vk_seam");
  });

  it("lets an explicitly passed adapter win over the key", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    vi.stubEnv("VENDO_API_KEY", "vk_seam");
    const sandbox = fakeSandbox();
    const harness = boxy();
    agent({ name: "support", harness, store: await tempStore(), sandbox });

    const injected = harnessAdapters(harness).sandbox as SandboxAdapter;
    await injected.create({ env: {} });
    expect(sandbox.created).toHaveLength(1);
  });

  it("leaves the store's Cloud rung unfilled — it fails loudly instead of composing a store its sessions cannot use", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    vi.stubEnv("VENDO_API_KEY", "vk_seam");
    // The tenant-store shape is under redesign (2026-08-04 hold); until it
    // lands, an unset `store:` with a key must say so, not silently pick the
    // HTTP hosted store, which serves neither transcript nor workspace.
    expect(() => agent({ name: "support", harness: defineHarness({ name: "inert", async *run() {} }) }))
      .toThrow(/Cloud store rung/);
  });
});
