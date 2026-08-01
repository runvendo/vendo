import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type TourEntry } from "./server.js";

/**
 * Tour mode over the real wire.
 *
 * The unit tests prove the matcher and the replay in isolation; this proves the
 * thing that actually matters to a host — that a tour turn and a live turn come
 * out of the SAME `POST /threads`, that the tour costs no model call, and that
 * everything a tour does not own still reaches the model exactly as it did
 * before tours existed.
 */

const principal: Principal = { kind: "user", subject: "user_tour" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A deterministic model double that COUNTS its calls — the count is the
 *  assertion: a tour turn must not make one. */
function countingModel(): { model: LanguageModel; calls: () => number } {
  let calls = 0;
  const model = {
    specificationVersion: "v2" as const,
    provider: "vendo-tour-test",
    modelId: "vendo-tour-test",
    supportedUrls: {},
    async doGenerate() {
      calls += 1;
      return {
        content: [{ type: "text" as const, text: "live answer" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream() {
      calls += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text_1" });
            controller.enqueue({ type: "text-delta", id: "text_1", delta: "live answer" });
            controller.enqueue({ type: "text-end", id: "text_1" });
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
  };
  return { model: model as unknown as LanguageModel, calls: () => calls };
}

const TOURS: TourEntry[] = [
  {
    prompt: [
      "Show me which units are behind on rent — build me a dashboard I can keep on my home page.",
      "Which units are behind on rent?",
    ],
    respond: "Five units are behind.",
  },
  { prompt: "Ping me on Slack when rent goes late", respond: "Rule armed." },
];

async function compose(): Promise<{
  ask: (text: string, threadId?: string) => Promise<{ body: string; threadId: string }>;
  modelCalls: () => number;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-tours-"));
  const store = createStore({ dataDir });
  const { model, calls } = countingModel();
  const vendo = createVendo({ model, principal: async () => principal, store, tours: TOURS });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let turn = 0;
  return {
    modelCalls: calls,
    ask: async (text, threadId) => {
      turn += 1;
      const response = await vendo.handler(
        new Request("https://host.test/api/vendo/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(threadId === undefined ? {} : { threadId }),
            message: { id: `m${turn}`, role: "user", parts: [{ type: "text", text }] },
          }),
        }),
      );
      expect(response.status).toBe(200);
      return {
        body: await response.text(),
        threadId: response.headers.get("x-vendo-thread-id") ?? "",
      };
    },
  };
}

describe("tour mode over POST /threads", () => {
  it("answers a frozen prompt from the tour, with no model call", async () => {
    const { ask, modelCalls } = await compose();
    const { body, threadId } = await ask("Which units are behind on rent?");
    expect(body).toContain("Five units are behind.");
    expect(body).not.toContain("live answer");
    expect(modelCalls()).toBe(0);
    // Same response contract as a live turn: the effective thread id comes back
    // on the header, so a fetch client adopts it without knowing which path
    // answered.
    expect(threadId).not.toBe("");
  });

  it("answers a typo'd variant the same way", async () => {
    const { ask, modelCalls } = await compose();
    const { body } = await ask("which units are behnid on rent");
    expect(body).toContain("Five units are behind.");
    expect(modelCalls()).toBe(0);
  });

  /**
   * THE REGRESSION. "a graph of tenants by rent owed" is about rent, and about
   * the very dashboard the tour just built — and it is a NEW ask. Under keyword
   * matching it replayed the tour. It has to reach the model.
   */
  it("sends a near-miss about the same subject to the live agent", async () => {
    const { ask, modelCalls } = await compose();
    const { body } = await ask("show me a graph of all the tenants I have with respect to how much rent they owe");
    expect(body).toContain("live answer");
    expect(body).not.toContain("Five units are behind.");
    expect(modelCalls()).toBe(1);
  });

  it("spends an entry after one turn — the same ask again reaches the live agent", async () => {
    const { ask, modelCalls } = await compose();
    const first = await ask("Which units are behind on rent?");
    expect(first.body).toContain("Five units are behind.");
    expect(modelCalls()).toBe(0);

    const second = await ask("Which units are behind on rent?", first.threadId);
    expect(second.body).toContain("live answer");
    expect(modelCalls()).toBe(1);
  });

  it("leaves the other entries alone in the same thread", async () => {
    const { ask, modelCalls } = await compose();
    const first = await ask("Which units are behind on rent?");
    const second = await ask("Ping me on Slack when rent goes late", first.threadId);
    expect(second.body).toContain("Rule armed.");
    expect(modelCalls()).toBe(0);
  });

  /** A tour turn persists through the same path a live turn does, so the next
   *  turn — live or scripted — reads it as ordinary history. */
  it("persists the scripted turn into the thread", async () => {
    const { ask } = await compose();
    const first = await ask("Which units are behind on rent?");
    const second = await ask("what did you just say?", first.threadId);
    expect(second.threadId).toBe(first.threadId);
    expect(second.body).toContain("live answer");
  });

  it("a fresh thread starts the tour over", async () => {
    const { ask, modelCalls } = await compose();
    await ask("Which units are behind on rent?");
    const fresh = await ask("Which units are behind on rent?");
    expect(fresh.body).toContain("Five units are behind.");
    expect(modelCalls()).toBe(0);
  });
});

describe("a host that configures no tours", () => {
  it("reaches the model for everything, exactly as before", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-no-tours-"));
    const store = createStore({ dataDir });
    const { model, calls } = countingModel();
    const vendo = createVendo({ model, principal: async () => principal, store });
    cleanups.push(async () => {
      await store.ensureSchema().catch(() => undefined);
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const response = await vendo.handler(
      new Request("https://host.test/api/vendo/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: { id: "m1", role: "user", parts: [{ type: "text", text: "Which units are behind on rent?" }] },
        }),
      }),
    );
    expect(await response.text()).toContain("live answer");
    expect(calls()).toBe(1);
  });
});
