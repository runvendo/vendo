/**
 * Prompt-cache warming (sub-1s shipment) — THE DRIFT GUARD.
 *
 * A warm call earns its cost only if the provider sees the EXACT prefix a real
 * turn sends: the tools block and the system prompt are the cacheable layers,
 * and one drifted byte means the real turn writes its own cold entry and the
 * warm one bought nothing. Warming is built to reuse the real assembly rather
 * than copy it, and this test is what keeps that true: a change that forks the
 * two prefixes fails here, at the provider seam, not in production cache bills.
 *
 * Real POST /threads/warm and real POST /threads through the same composed
 * vendo — no mocks on either side of the wire; only the model is a probe.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_warm" };

/** What the provider caches, per call: the serialized tools block and the
 *  system half of the prompt, exactly as they cross the model seam. */
interface SeenPrefix {
  tools: string;
  system: string;
}

function recordingModel(seen: SeenPrefix[]): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "probe",
    modelId: "probe-v1",
    supportedUrls: {},
    async doStream(call: {
      prompt: Array<{ role: string; content: unknown }>;
      tools?: unknown;
    }) {
      seen.push({
        tools: JSON.stringify(call.tools ?? []),
        system: call.prompt
          .filter((m) => m.role === "system")
          .map((m) => (typeof m.content === "string"
            ? m.content
            : (m.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n")))
          .join("\n"),
      });
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

async function compose(): Promise<{ vendo: Vendo; seen: SeenPrefix[] }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-warm-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const seen: SeenPrefix[] = [];
  const vendo = createVendo({
    models: { default: recordingModel(seen) },
    principal: async () => principal,
    store,
  });
  return { vendo, seen };
}

const post = (vendo: Vendo, path: string, body: unknown = {}): Promise<Response> =>
  vendo.handler(new Request(`https://host.test/api/vendo${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

describe("warm prefix — byte-identical to a real turn's cacheable layers", () => {
  it("warm and a real first message serialize the same tools block and system prompt", async () => {
    const { vendo, seen } = await compose();

    const warmed = await post(vendo, "/threads/warm");
    expect(warmed.status).toBe(204);
    expect(seen).toHaveLength(1);

    await (await post(vendo, "/threads", {
      threadId: "thr_prefix_seam_1",
      message: {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "what can you do?" }],
      } as UIMessage,
      context: { screen: "https://maple.test/home\n- heading \"Home\"" },
    })).text();
    expect(seen).toHaveLength(2);

    const [warm, real] = seen as [SeenPrefix, SeenPrefix];
    // The two cacheable layers, exactly equal — tools first, because a tools
    // mismatch invalidates everything after it.
    expect(warm.tools).toBe(real.tools);
    expect(warm.system).toBe(real.system);
    // …and the warm turn left nothing behind: no thread, no transcript.
    const threads = await (await vendo.handler(
      new Request("https://host.test/api/vendo/threads"),
    )).json() as unknown[];
    expect(JSON.stringify(threads)).not.toContain("thr_warm");
  });
});
