/**
 * `TurnRunInput.observe` — every event the harness yields, as the runtime routes
 * it. It is a tap, not a route: what reaches the wire is what reached it before
 * the hook existed, so both halves are asserted on one turn.
 */
import type { Harness, HarnessEvent, ThreadId, Turn } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { defineHarness } from "../src/define.js";
import { createHarnessRuntime } from "../src/runtime.js";
import {
  boundRegistry,
  ctx,
  readSse,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  unusedModels,
  userMessage,
} from "../src/test-doubles.test-util.js";

const THREAD = "thr_observe" as ThreadId;

describe("the runtime's observe tap", () => {
  it("sees every event in order, and does not change what the wire carries", async () => {
    const yielded: HarnessEvent[] = [
      { type: "status", label: "thinking" },
      { type: "text", delta: "hello" },
      { type: "usage", inputTokens: 10, outputTokens: 3 },
    ];
    const harness: Harness = defineHarness({
      name: "talker",
      async *run(_turn: Turn): AsyncGenerator<HarnessEvent, void, void> {
        for (const event of yielded) yield event;
      },
    });
    const guard = testGuard();
    const runtime = createHarnessRuntime({
      tools: boundRegistry({}, guard),
      guard,
      skills: testSkills(),
      transcript: testTranscript(),
    });
    const seen: HarnessEvent[] = [];
    const response = await runtime.run({
      harness,
      threadId: THREAD,
      messages: [userMessage("m1", "hi")],
      ctx: ctx(),
      workspace: testWorkspace({}),
      models: unusedModels(),
      interactive: true,
      observe: (event) => { seen.push(event); },
    });
    const parts = await readSse(response);

    expect(seen).toEqual(yielded);
    // Usage is audit-only by contract, so seeing it in the tap must not put it
    // on the wire — the tap's whole point is reaching what the wire never shows.
    expect(parts.some((part) => part["type"] === "text-delta" && part["delta"] === "hello")).toBe(true);
    expect(parts.some((part) => String(part["type"]).includes("usage"))).toBe(false);
  });
});
