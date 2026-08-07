/**
 * Explicit retries and ordered provider failover (§4.1 item 3).
 *
 * `maxRetries` was unset, so the loop inherited whatever the SDK's default
 * happened to be — a posture nobody chose and nobody could read off the code.
 * And there was no failover at all: `startTurn` took one resolved model and had
 * no way to be told about a second.
 *
 * The boundary under test is FIRST BYTE. A provider that fails before producing
 * output has produced nothing anyone saw, so the next model can serve the whole
 * answer; once output is streaming, switching would duplicate it, so the failure
 * travels instead. Both halves are asserted — a "failover" that also fired
 * mid-stream would be a correctness bug, not a more generous version of this one.
 */
import { APICallError } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_RETRIES, startTurn, type TurnLoopOptions } from "./loop.js";
import { ZERO_USAGE } from "../test-doubles.test-util.js";

afterEach(() => {
  vi.restoreAllMocks();
});

type Chunks = Parameters<typeof simulateReadableStream>[0]["chunks"];

/** A provider failure the SDK is willing to retry — the shape that makes the
 *  retry budget observable at all. */
const overloaded = (): APICallError => new APICallError({
  message: "Overloaded",
  url: "https://api.example.test/v1/messages",
  requestBodyValues: {},
  statusCode: 503,
});

const answer = (text: string): Chunks => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
];

/** Named models that record the ORDER the ladder tried them in. */
function ladder(...rungs: Array<{ id: string; behave: () => Promise<Chunks> }>) {
  const attempts: string[] = [];
  const models = rungs.map((rung) => new MockLanguageModelV3({
    modelId: rung.id,
    doStream: async () => {
      attempts.push(rung.id);
      return { stream: simulateReadableStream({ chunks: await rung.behave() }) };
    },
  }));
  return { attempts, models };
}

async function drain(options: Omit<TurnLoopOptions, "system" | "messages" | "tools">) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const loop = await startTurn({
    system: "system",
    messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
    tools: {},
    ...options,
  });
  let text = "";
  const errors: unknown[] = [];
  for await (const part of loop.result.fullStream) {
    if (part.type === "text-delta") text += part.text;
    if (part.type === "error") errors.push(part.error);
  }
  return { text, errors };
}

describe("the retry budget", () => {
  it("is EXPLICIT — a caller can spend nothing", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw overloaded();
      },
    });
    await drain({ model, context: { maxRetries: 0 } });
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("defaults to the named constant rather than whatever the SDK ships", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw overloaded();
      },
    });
    await drain({ model });
    expect(model.doStreamCalls).toHaveLength(DEFAULT_MAX_RETRIES + 1);
    // The SDK's backoff between retries is a real sleep (~2s then ~4s), so this
    // test's own wall clock has to be looser than the work it waits on — a
    // tighter budget would report a product bug for a spec-conformant delay.
  }, 30_000);
});

describe("ordered provider failover", () => {
  it("falls over when the primary fails BEFORE a byte, in order", async () => {
    const { attempts, models } = ladder(
      { id: "primary", behave: () => Promise.reject(overloaded()) },
      { id: "second", behave: async () => answer("the second rung served") },
    );
    const [primary, second] = models;
    const { text, errors } = await drain({
      model: primary!,
      fallbacks: [second!],
      context: { maxRetries: 0 },
    });

    expect(text).toBe("the second rung served");
    expect(errors).toEqual([]);
    // The ORDER is the contract: a ladder that tried the fallback first would
    // silently demote the seat the host chose.
    expect(attempts).toEqual(["primary", "second"]);
  });

  it("falls over on a stream that errors at its first output part", async () => {
    // A provider that accepted the call and then failed has still produced
    // nothing a user saw. `stream-start` carries warnings, not output, so it
    // must not count as a committed byte.
    const { attempts, models } = ladder(
      {
        id: "primary",
        behave: async () => [
          { type: "stream-start", warnings: [] },
          { type: "error", error: overloaded() },
        ],
      },
      { id: "second", behave: async () => answer("recovered") },
    );
    const { text, errors } = await drain({
      model: models[0]!,
      fallbacks: [models[1]!],
      context: { maxRetries: 0 },
    });

    expect(text).toBe("recovered");
    expect(errors).toEqual([]);
    expect(attempts).toEqual(["primary", "second"]);
  });

  it("does NOT fall over once output is streaming — that would duplicate it", async () => {
    const { attempts, models } = ladder(
      {
        id: "primary",
        behave: async () => [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "half an answ" },
          { type: "error", error: overloaded() },
        ],
      },
      { id: "second", behave: async () => answer("a whole second answer") },
    );
    const { text, errors } = await drain({
      model: models[0]!,
      fallbacks: [models[1]!],
      context: { maxRetries: 0 },
    });

    expect(text).toBe("half an answ");
    expect(errors).toHaveLength(1);
    expect(attempts).toEqual(["primary"]);
  });

  it("surfaces the LAST rung's failure when every rung fails", async () => {
    const { attempts, models } = ladder(
      { id: "primary", behave: () => Promise.reject(overloaded()) },
      { id: "second", behave: () => Promise.reject(overloaded()) },
    );
    const { errors } = await drain({
      model: models[0]!,
      fallbacks: [models[1]!],
      context: { maxRetries: 0 },
    });
    expect(errors).toHaveLength(1);
    expect(attempts).toEqual(["primary", "second"]);
  });

  it("does not walk the ladder for a turn the caller cancelled", async () => {
    // Otherwise one hang-up calls every provider the host configured.
    const abort = new AbortController();
    const { attempts, models } = ladder(
      {
        id: "primary",
        behave: () => {
          abort.abort();
          return Promise.reject(new Error("aborted"));
        },
      },
      { id: "second", behave: async () => answer("never") },
    );
    await drain({
      model: models[0]!,
      fallbacks: [models[1]!],
      signal: abort.signal,
      context: { maxRetries: 0 },
    });
    expect(attempts).toEqual(["primary"]);
  });
});
