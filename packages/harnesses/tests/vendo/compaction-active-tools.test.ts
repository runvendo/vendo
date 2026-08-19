/**
 * The compaction estimate must bill the tools the prompt actually CARRIES.
 *
 * `activeTools` gates which tools reach the provider — `streamText` receives the
 * gated list, and `prepareStep` re-applies it on every step — so a tool outside
 * the loadout costs the window nothing. The estimate was reading
 * `options.tools`, the whole equipped set, so a curated surface with a small
 * loadout behind a large catalog was charged for the catalog: the trigger fired
 * on tokens that were never sent, and the shed floor then charged the messages
 * against a figure the prompt had never reached.
 *
 * The 2-chars-per-token ratio is not what is under test here and is unchanged —
 * this is about WHICH tools go into the count, not what a character is worth.
 */
import type { TurnId } from "@vendoai/core";
import { tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startTurn } from "../../src/vendo/loop.js";
import { openWorkbench, type WorkbenchEvent } from "../../src/workbench.js";

/** A tool whose SCHEMA is the bulk, as a real host tool's is. ~40k characters
 *  is ~20k tokens at the loop's own conversion, so a tool that is billed and
 *  should not be is impossible to miss. */
const fatTool = (name: string) => tool({
  description: `${name}. ${"d".repeat(20_000)}`,
  inputSchema: z.object({ value: z.string().describe("x".repeat(20_000)) }),
  execute: async () => ({}),
});

const quietModel = () => new MockLanguageModelV3({
  doStream: async () => ({
    stream: simulateReadableStream({ chunks: [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "ok" },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        finishReason: { unified: "stop", raw: undefined },
      },
    ] }),
  }),
});

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  delete process.env["VENDO_WORKBENCH"];
});

/** The estimate this turn tripped on, read off the workbench's `context` fact —
 *  the loop's own report of what it thinks its prompt costs. */
async function estimateWith(label: string, activeTools?: () => string[]): Promise<number> {
  process.env["VENDO_WORKBENCH"] = "1";
  const turnId = `trn_${label}` as TurnId;
  const events: WorkbenchEvent[] = [];
  closers.push(openWorkbench(turnId, (part) => { events.push(part.event); }));
  const model = quietModel();
  const loop = await startTurn({
    model,
    system: "system",
    messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }],
    tools: { alpha: fatTool("alpha"), beta: fatTool("beta") },
    turnId,
    // A window large enough that nothing actually compacts — the `context` fact
    // is emitted whatever the trigger decides, and the estimate is the subject.
    compaction: { model, contextWindowTokens: 1_000_000 },
    ...(activeTools === undefined ? {} : { activeTools }),
  });
  await loop.result.consumeStream();
  const context = events.find((event): event is Extract<WorkbenchEvent, { kind: "context" }> =>
    event.kind === "context");
  expect(context, "the loop reported no context estimate").toBeDefined();
  return context!.estTokens;
}

describe("the compaction estimate", () => {
  it("bills only the tools the loadout lets the model pick", async () => {
    const gated = await estimateWith("gated", () => ["alpha"]);
    const ungated = await estimateWith("ungated");

    // One whole fat tool's worth of schema is the difference, and it is the
    // difference the provider sees too: `beta` is not on the wire for the gated
    // turn. Billed identically, this is 0.
    expect(ungated - gated).toBeGreaterThan(15_000);
  });

  it("bills the whole equipped set when there is no loadout to gate it", async () => {
    // No `activeTools` means every equipped tool really is sent, so the estimate
    // charging all of them is correct — the fix must not shrink this case.
    const all = await estimateWith("all-a");
    const both = await estimateWith("both", () => ["alpha", "beta"]);
    expect(Math.abs(all - both)).toBeLessThan(50);
  });
});
