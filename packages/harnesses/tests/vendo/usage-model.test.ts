/**
 * What the metering row says the tokens were spent ON.
 *
 * Vendo's own seat is LAZY: it answers `vendo-env` for its own id and picks the
 * rung on the first call, so every usage event a deployment on it emitted named
 * a FAMILY, not a model — and usage is what hosts meter and price on. The
 * resolved id is not knowable before the call and IS reported on it, which the
 * window table already reads; the same record answers here.
 */
import type { ToolRegistry, Turn } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { createTurnState } from "../../src/harness-state.js";
import { createTurnTools } from "../../src/turn-tools.js";
import { vendo, type VendoHarnessOptions } from "../../src/vendo/vendo.js";
import {
  ctx,
  seats,
  testGuard,
  testSkills,
  testWorkspace,
  userMessage,
} from "../../src/test-doubles.test-util.js";

const NO_TOOLS: ToolRegistry = {
  descriptors: async () => [],
  execute: async () => ({ status: "error", error: { code: "not-found", message: "no tools" } }),
};

/** A seat that calls itself one thing and is SERVED by another — the shape of
 *  every `vendoModel()` deployment. */
const lazySeat = (modelId: string, respondsAs: string): LanguageModel =>
  new MockLanguageModelV3({
    modelId,
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "response-metadata" as const, modelId: respondsAs },
          { type: "text-start" as const, id: "t1" },
          { type: "text-delta" as const, id: "t1", delta: "ok" },
          { type: "text-end" as const, id: "t1" },
          {
            type: "finish" as const,
            usage: {
              inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 7, text: 7, reasoning: 0 },
            },
            finishReason: { unified: "stop" as const, raw: undefined },
          },
        ],
      }),
    }),
  }) as unknown as LanguageModel;

async function usageModels(model: LanguageModel): Promise<Array<string | undefined>> {
  const turnTools = createTurnTools({
    registry: NO_TOOLS,
    guard: testGuard(),
    ctx: ctx(),
    interactive: true,
    mirror: () => {},
  });
  const turn: Turn<VendoHarnessOptions> = {
    threadId: "thr_usage_model",
    turnId: "trn_usage_model",
    messages: [userMessage("m1", "hello")],
    tools: turnTools,
    skills: testSkills(),
    workspace: testWorkspace(),
    models: seats(model),
    state: createTurnState(undefined),
    options: {},
    signal: new AbortController().signal,
    interactive: true,
  };
  const models: Array<string | undefined> = [];
  for await (const event of vendo().run(turn)) {
    if (event.type === "usage") models.push(event.model);
  }
  turnTools.dispose();
  return models;
}

describe("usage.model", () => {
  it("is the model that SERVED the turn, not the lazy seat's family name", async () => {
    expect(await usageModels(lazySeat("vendo-env", "claude-sonnet-4-6-20260101")))
      .toEqual(["claude-sonnet-4-6-20260101"]);
  });

  it("is the seat's own id when the provider reported none", async () => {
    const silent = new MockLanguageModelV3({
      modelId: "claude-opus-4-1",
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "t1" },
            { type: "text-delta" as const, id: "t1", delta: "ok" },
            { type: "text-end" as const, id: "t1" },
            {
              type: "finish" as const,
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              finishReason: { unified: "stop" as const, raw: undefined },
            },
          ],
        }),
      }),
    }) as unknown as LanguageModel;

    expect(await usageModels(silent)).toEqual(["claude-opus-4-1"]);
  });
});
