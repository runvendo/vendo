/**
 * A per-tenant token ceiling (§4.1 item 4).
 *
 * The loop's `stopWhen` was a hardcoded array literal — three conditions and no
 * seam — so a caller who needed a fourth had no way to add one and would have
 * had to build a second stop mechanism beside it. It takes extra conditions now,
 * and the ceiling is one member of that array rather than a new rail.
 *
 * Modelled on step-cap.test.ts: the scripted model carries exactly as many turns
 * as the run is allowed, so `doStreamCalls.length` — not a claim about intent —
 * is what proves the loop stopped.
 */
import { tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startTurn, tokenBudgetStop } from "./loop.js";

/** 100 tokens a step, so a ceiling lands between steps unambiguously. */
const STEP_USAGE = {
  inputTokens: { total: 60, noCache: 60, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 40, text: 40, reasoning: 0 },
} as const;
const TOKENS_PER_STEP = 100;

const echo = tool({
  description: "Echo a value back.",
  inputSchema: z.object({ value: z.string() }),
  execute: async (input: { value: string }) => input,
});

/** A model that asks for one more tool call every step, forever. */
function insatiableModel() {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      step += 1;
      return {
        stream: simulateReadableStream({ chunks: [
          { type: "tool-call", toolCallId: `call_${step}`, toolName: "echo", input: JSON.stringify({ value: `v${step}` }) },
          { type: "finish", usage: STEP_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
        ] }),
      };
    },
  });
}

async function run(options: { budget?: number; maxSteps: number }) {
  const model = insatiableModel();
  const loop = await startTurn({
    model,
    system: "system",
    messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "keep going" }] }],
    tools: { echo },
    context: { maxSteps: options.maxSteps },
    ...(options.budget === undefined ? {} : { stopWhen: [tokenBudgetStop(options.budget)] }),
  });
  for await (const _part of loop.result.fullStream) { /* drain */ }
  return model.doStreamCalls.length;
}

describe("a per-tenant token budget", () => {
  it("stops after the step that crosses the ceiling", async () => {
    // Step 1 spends 100 (under 150, so the loop continues); step 2 puts the run
    // at 200 (over, so it stops). A condition is consulted after a step, so
    // "crossing" always costs the step that crossed — which is why the ceiling is
    // a budget and not a hard cap.
    expect(await run({ budget: TOKENS_PER_STEP + 50, maxSteps: 10 })).toBe(2);
  });

  it("changes nothing when it is unset", async () => {
    // OPT-IN: the same insatiable model, no ceiling, runs to the step cap.
    expect(await run({ maxSteps: 4 })).toBe(4);
  });

  it("stops on the FIRST step when the ceiling is below one step's spend", async () => {
    expect(await run({ budget: 1, maxSteps: 10 })).toBe(1);
  });

  it("leaves the loop's own three conditions in force", async () => {
    // The extras are composed with the shipped array, never a replacement for it:
    // a generous ceiling must still hit the step cap.
    expect(await run({ budget: 1_000_000, maxSteps: 3 })).toBe(3);
  });
});
