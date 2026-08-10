/**
 * The turn's WALL CLOCK, and what it does to the retry budget.
 *
 * `DEFAULT_MAX_RETRIES = 2` means every step can cost three provider calls, so a
 * ten-step turn's true worst case is thirty of them — and no rail on this loop
 * counted anything but steps. A retry is right when the provider is briefly
 * overloaded and wrong when the caller has already stopped waiting, and only a
 * clock tells those apart.
 *
 * Modelled on token-budget.test.ts: the thinker is scripted and
 * `doStreamCalls.length` — not a claim about intent — is what proves the loop
 * stopped. Nothing here stubs the retry machinery: the real `streamText` decides
 * whether to re-issue the call, so the clock and the retry budget are measured
 * where they actually meet.
 */
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { startTurn, DEFAULT_MAX_RETRIES } from "../../src/vendo/loop.js";

/** A provider failure the SDK is willing to retry — the shape that makes the
 *  retry budget observable at all (`vendo.test.ts` uses the same one). */
const overloaded = (): APICallError => new APICallError({
  message: "Overloaded",
  url: "https://api.example.test/v1/messages",
  requestBodyValues: {},
  statusCode: 503,
});

async function drain(model: MockLanguageModelV3, turnBudgetMs?: number): Promise<void> {
  const loop = await startTurn({
    model,
    system: "system",
    messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "assemble" }] }],
    tools: {},
    context: { maxSteps: 4, ...(turnBudgetMs === undefined ? {} : { turnBudgetMs }) },
  });
  // The failure reaches the caller as an `error` part, so draining is enough.
  for await (const _part of loop.result.fullStream) { /* drain */ }
}

describe("a turn's wall clock", () => {
  it("refuses a retry the clock cannot pay for", async () => {
    // The SDK's first backoff is seconds long, so a one-second clock cannot fit a
    // retry at all: the call is not dialled, and the loop does not sit waiting for
    // an answer nobody is still there to read.
    const clocked = new MockLanguageModelV3({ doStream: () => Promise.reject(overloaded()) });
    await drain(clocked, 1_000);
    expect(clocked.doStreamCalls).toHaveLength(1);

    // The SAME model with no clock spends the whole retry budget — which is the
    // behaviour every caller keeps until it names a budget.
    const unclocked = new MockLanguageModelV3({ doStream: () => Promise.reject(overloaded()) });
    await drain(unclocked);
    expect(unclocked.doStreamCalls).toHaveLength(DEFAULT_MAX_RETRIES + 1);
  });

  it("rides the provider call's own signal, not just the gaps between steps", async () => {
    // The 240.9s call is the reason: a stop condition is consulted after a step,
    // so a step that never ends is never asked about. The budget reaches the
    // provider call itself — which is the same signal a retry would inherit.
    const stalled = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => await new Promise((_resolve, reject) => {
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason as Error));
      }),
    });
    // However the failure surfaces (an `error` part or a throw out of the drain),
    // the point is that it surfaces at all rather than hanging on the clock.
    await drain(stalled, 600).catch(() => undefined);
    expect(stalled.doStreamCalls).toHaveLength(1);
    expect(stalled.doStreamCalls[0]?.abortSignal?.aborted).toBe(true);
  });
});
