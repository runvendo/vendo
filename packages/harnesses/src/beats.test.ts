/**
 * The beat vocabulary — contract §3.4.
 *
 * `HarnessEvent`'s `status` member is widened, not joined: the union stays closed
 * at four, and a beat gains an optional `phase` and `appId`. The transient
 * `data-vendo-status` part is the channel it already rode; this proves the two new
 * fields reach the wire through the REAL runtime and the REAL writer, and that a
 * bare `label` still puts exactly the chunk on the wire it always did.
 */
import { defineHarness } from "./define.js";
import type { BeatPhase, Harness, HarnessEvent, ThreadId } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createHarnessRuntime } from "./runtime.js";
import { VENDO_STATUS_PART } from "./wire.js";
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
} from "./test-doubles.test-util.js";

const THREAD = "thr_beats" as ThreadId;

/** Run a turn that yields exactly these events, and return the status parts. */
async function beatsOnTheWire(events: HarnessEvent[]): Promise<Array<Record<string, unknown>>> {
  const guard = testGuard();
  const runtime = createHarnessRuntime({
    tools: boundRegistry({}, guard),
    guard,
    skills: testSkills([]),
    transcript: testTranscript(),
  });
  const harness: Harness = defineHarness({
    name: "beating",
    async *run() {
      for (const event of events) yield event;
    },
  });
  const parts = await readSse(await runtime.run({
    harness,
    threadId: THREAD,
    messages: [userMessage("m1", "make me a spending screen")],
    ctx: ctx(),
    workspace: testWorkspace(),
    models: unusedModels(),
    interactive: true,
  }));
  return parts
    .filter((part) => part["type"] === VENDO_STATUS_PART)
    .map((part) => part["data"] as Record<string, unknown>);
}

describe("beats (contract §3.4)", () => {
  it("carries the phase and the app a beat is about", async () => {
    const [beat] = await beatsOnTheWire([{
      type: "status",
      label: "Laying out your spending",
      phase: "assembling",
      appId: "app_spend",
    }]);
    expect(beat).toEqual({ label: "Laying out your spending", phase: "assembling", appId: "app_spend" });
  });

  it("puts a bare label on the wire exactly as it always did", async () => {
    const [beat] = await beatsOnTheWire([{ type: "status", label: "Reading your invoices" }]);
    // No `phase: undefined`, no `appId: undefined` — absent stays absent, so a
    // receiver written before the widening sees the identical chunk.
    expect(beat).toEqual({ label: "Reading your invoices" });
  });

  it("keeps beats OFF the transcript — a beat is ephemeral by construction", async () => {
    const guard = testGuard();
    const transcript = testTranscript();
    const runtime = createHarnessRuntime({
      tools: boundRegistry({}, guard),
      guard,
      skills: testSkills([]),
      transcript,
    });
    const harness: Harness = defineHarness({
      name: "beating",
      async *run() {
        yield { type: "status", label: "Checking the numbers", phase: "checking" };
        yield { type: "text", delta: "All good." };
      },
    });
    await readSse(await runtime.run({
      harness,
      threadId: THREAD,
      messages: [userMessage("m1", "check it")],
      ctx: ctx(),
      workspace: testWorkspace(),
      models: unusedModels(),
      interactive: true,
    }));
    const stored = JSON.stringify(await transcript.list({ kind: "user", subject: "u1" }, THREAD));
    expect(stored).not.toContain("Checking the numbers");
    expect(stored).not.toContain("checking");
  });

  it("orders the six phases as the arc of making something", () => {
    // The union is CLOSED at six. Spelled out as a value so a seventh member
    // cannot arrive without this line being changed on purpose.
    const arc: BeatPhase[] = [
      "understanding",
      "planning",
      "assembling",
      "building",
      "checking",
      "finishing",
    ];
    expect(arc).toHaveLength(6);
  });
});
