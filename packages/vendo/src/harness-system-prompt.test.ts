/**
 * What the thinker is TOLD, across every reachable composition.
 *
 * This pins wave-1 live-proof P1 (`packages/vendo/proofs/p1-harness-path.mjs`),
 * which measured the three reachable ways a turn reaches a model and found the
 * documented opt-in — `harness: vendo()` — thinking with a ZERO-character system
 * prompt: no product brief, no catalog, no knowledge index, silently. The prompt
 * is assembled by composition because it needs the turn's `RunContext`, which a
 * `Turn` deliberately does not carry (§1), so a host could not work around it.
 *
 * The assertion is deliberately the strong one: non-empty AND identical. "Both
 * paths get something" would have passed while they drifted.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connector } from "@vendoai/actions";
import type { Harness, Principal, RunContext, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { defineHarness, vendo as vendoHarness } from "@vendoai/harnesses";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import * as serverExports from "./server.js";
import { createVendo, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_prompt" };

const HOST_VOICE = "PROBE-VOICE: speak like Maple.";

/** Records every system prompt it is asked to think with, then says one line. */
function recordingModel(seen: string[]): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "probe",
    modelId: "probe-v1",
    supportedUrls: {},
    async doStream(call: { prompt: Array<{ role: string; content: unknown }> }) {
      seen.push(
        call.prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n"),
      );
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
}

const hostTools = (): ToolRegistry => {
  const descriptor: ToolDescriptor = {
    name: "maple_listAccounts",
    title: "List accounts",
    description: "List the signed-in customer's accounts",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  };
  return {
    async descriptors() {
      return [descriptor];
    },
    async execute() {
      return { status: "ok", output: { accounts: [] } };
    },
  };
};

interface Composed {
  vendo: Vendo;
  seen: string[];
}

async function compose(
  overrides: Partial<Parameters<typeof createVendo>[0]> = {},
): Promise<Composed> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-prompt-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const seen: string[] = [];
  const vendo = createVendo({
    model: recordingModel(seen),
    principal: async () => principal,
    store,
    instructions: HOST_VOICE,
    ...overrides,
  } as Parameters<typeof createVendo>[0]);
  vendo.actions.add(hostTools());
  return { vendo, seen };
}

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

const post = (vendo: Vendo, body: unknown): Promise<Response> =>
  vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

const ctx = (): RunContext => ({
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "sess_prompt",
} as RunContext);

describe("the assembled system prompt reaches every composition", () => {
  it("is non-empty and IDENTICAL for the legacy wire, a named harness, and the composed door", async () => {
    // 1. No `harness:` — POST /threads stays on the legacy `createAgent`.
    const legacy = await compose({});
    await (await post(legacy.vendo, { threadId: "thr_1", message: userMessage("m1", "hello") })).text();

    // 2. `harness: vendo()` — the literal §10 opt-in, the one that measured 0 chars.
    const named = await compose({ harness: vendoHarness() as never });
    await (await post(named.vendo, { threadId: "thr_2", message: userMessage("m2", "hello") })).text();

    // 3. No `harness:` — driven through the composed `vendo.harness` door.
    const composed = await compose({});
    await (await composed.vendo.harness.stream({
      threadId: "thr_3",
      message: userMessage("m3", "hello"),
      ctx: ctx(),
    })).text();

    const prompts = {
      legacyWire: legacy.seen[0] ?? "",
      namedHarness: named.seen[0] ?? "",
      composedDoor: composed.seen[0] ?? "",
    };

    // A thinker with nothing to think with is the bug, so length is asserted
    // before equality — three empty strings are also "identical".
    for (const [path, prompt] of Object.entries(prompts)) {
      expect(prompt.length, `${path} thought with an empty system prompt`).toBeGreaterThan(500);
      // The three anchors P1 measured: the host's voice, the guard's directions,
      // and the discovery rail.
      expect(prompt, `${path} lost the host's voice`).toContain(HOST_VOICE);
      expect(prompt, `${path} lost find_tools`).toContain("find_tools");
    }

    expect(prompts.namedHarness).toBe(prompts.legacyWire);
    expect(prompts.composedDoor).toBe(prompts.legacyWire);
  });

  /**
   * D8: which discovery section a turn may promise is decided by what is actually
   * on ITS listing. Teaching a tool that is not there is the same lie either way —
   * `find_tools` on an uncurated surface, or `find_service_tools` in a deployment
   * whose connector cannot search the broker's catalog (the pair is projected only
   * when one can).
   */
  it("promises only the discovery rail this harness and this deployment actually have", async () => {
    const told: Record<string, string> = {};
    /** A scripted harness that reports the brief it was handed, nothing else. */
    const probe = (name: string, toolSurface?: Harness["toolSurface"]) =>
      defineHarness({
        name,
        ...(toolSurface === undefined ? {} : { toolSurface }),
        async *run(turn) {
          told[name] = turn.system ?? "";
          yield { type: "text", delta: "ok" };
        },
      }) as never;
    /** A connector that can search, grade and run the broker's catalog — all
     *  three, because that is exactly what the pair is gated on. */
    const connector: Connector = {
      name: "composio",
      descriptors: async () => [],
      execute: async () => ({ status: "ok", output: {} }),
      searchTools: async () => [],
      toolRisk: async () => "read",
      executeSlug: async () => ({ status: "ok", output: {} }),
    };

    const curated = await compose({ harness: probe("curated") });
    await (await post(curated.vendo, { threadId: "thr_d1", message: userMessage("m1", "hi") })).text();

    const bare = await compose({ harness: probe("uncurated-bare", { curated: false }) });
    await (await post(bare.vendo, { threadId: "thr_d2", message: userMessage("m2", "hi") })).text();

    const wired = await compose({
      harness: probe("uncurated-connectors", { curated: false }),
      connectors: [connector],
    });
    await (await post(wired.vendo, { threadId: "thr_d3", message: userMessage("m3", "hi") })).text();

    // A connector with connections but no catalog behind it (the zero-key Cloud
    // default): `list_connections` is projected, the pair is not.
    const { searchTools: _s, toolRisk: _r, executeSlug: _e, ...connectionsOnly } = connector;
    const partial = await compose({
      harness: probe("uncurated-connections-only", { curated: false }),
      connectors: [connectionsOnly],
    });
    await (await post(partial.vendo, { threadId: "thr_d4", message: userMessage("m4", "hi") })).text();

    // A curated surface has `find_tools`, so it is taught the search budget.
    expect(told["curated"]).toContain("find_tools");
    expect(told["curated"]).not.toContain("find_service_tools");
    // Uncurated with no connectors: neither rail exists, so neither is promised.
    expect(told["uncurated-bare"]).not.toContain("find_tools");
    expect(told["uncurated-bare"]).not.toContain("find_service_tools");
    // Uncurated WITH a searchable connector: the pair is projected, so the
    // connectors section rides — and `find_tools`, not on this listing, does not.
    expect(told["uncurated-connectors"]).toContain("find_service_tools");
    expect(told["uncurated-connectors"]).toContain("use_service_tool");
    expect(told["uncurated-connectors"]).toContain("list_connections");
    expect(told["uncurated-connectors"]).not.toContain("find_tools");
    // Connections-only: the section names the pair by name, so teaching it here
    // would be the same lie in the other direction.
    expect(told["uncurated-connections-only"]).not.toContain("find_service_tools");
    expect(told["uncurated-connections-only"]).not.toContain("Connectors");
  });

  it("names the default harness from the umbrella alone — §10's one-liner needs one dependency", () => {
    // The opt-in the spec documents is `createVendo({ harness: vendo() })`. Both
    // names have to come out of the package the host installed, or the one-liner
    // costs a second direct dependency on @vendoai/harnesses to compile.
    expect(serverExports.vendo).toBe(vendoHarness);
    expect(serverExports.vendo().name).toBe("vendo");
  });
});
