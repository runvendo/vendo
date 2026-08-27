/**
 * What the USER reads, proven end to end: the real `vendo()` loop, the real
 * runtime, the real wire. Both defects here were photographed in one TaxDome
 * answer, and both were invisible to a suite that stopped at the harness events
 * — the leak is in what the loop TELLS the model, and the run-on only exists
 * once `TextChannel` has folded the loop's deltas into transcript parts.
 */
import type { ThreadId, ToolDescriptor } from "@vendoai/core";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { expect, it } from "vitest";
import { createHarnessRuntime } from "../src/runtime.js";
import { vendo } from "../src/vendo/vendo.js";
import {
  boundRegistry,
  ctx,
  readSse,
  seats,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  userMessage,
  ZERO_USAGE,
  type StreamPart,
} from "../src/test-doubles.test-util.js";

const THREAD = "thr_voice" as ThreadId;

/** A host tool shaped the way TaxDome's really are: an operational description
 *  and NO authored title, which is what `.vendo/tools.json` holds when sync's
 *  enrichment never wrote one. */
const untitled: ToolDescriptor = {
  name: "host_getClient",
  description: "Look up one client account by id.",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  risk: "read",
};

/** One model step carrying SEVERAL text blocks and no tool call — the shape
 *  interleaved thinking produces, and the one nothing mirrors. */
function textBlocks(...blocks: string[]): StreamPart[] {
  return [
    ...blocks.flatMap((text, index): StreamPart[] => [
      { type: "text-start", id: `t${index}` },
      { type: "text-delta", id: `t${index}`, delta: text },
      { type: "text-end", id: `t${index}` },
    ]),
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
  ];
}

/** Drive one turn through the shipped rails, keeping both the toolset the model
 *  was handed and the parts the transcript received. */
async function turn(chunks: StreamPart[]) {
  const guard = testGuard();
  const registry = boundRegistry(
    { host_getClient: { descriptor: untitled, execute: () => ({ ok: true }) } },
    guard,
  );
  const offered: Array<{ name: string; description?: string }> = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      offered.push(...request.tools ?? []);
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  const runtime = createHarnessRuntime({
    tools: registry,
    guard,
    skills: testSkills(),
    transcript: testTranscript(),
  });
  const parts = await readSse(await runtime.run({
    harness: vendo(),
    threadId: THREAD,
    messages: [userMessage("m1", "file these under the right clients")],
    ctx: ctx(),
    workspace: testWorkspace(),
    models: seats(model),
    interactive: true,
  }));
  return { offered, parts };
}

it("hands the model a human title for a host tool that authored none", async () => {
  const { offered } = await turn(textBlocks("done"));
  // The identifier stays the CALL name — it has to. What must not be the only
  // proper noun the model holds is that identifier: told to say a tool's title
  // and given none, it said `host_getClient` to a TaxDome user whose own design
  // rules forbid printing an internal id.
  expect(offered.find(tool => tool.name === "host_getClient")?.description)
    .toBe("Get client — Look up one client account by id.");
});

it("keeps two of the model's own text blocks from running together", async () => {
  const { parts } = await turn(textBlocks(
    "There's no document upload/filing capability exposed here.",
    "No matching tool exists for filing a document under a client in this host.",
  ));
  const answer = parts
    .filter(part => part.type === "text-delta")
    .map(part => part.delta as string)
    .join("");
  expect(answer).not.toContain("here.No matching");
  expect(answer).toBe(
    "There's no document upload/filing capability exposed here."
    + "\n\nNo matching tool exists for filing a document under a client in this host.",
  );
});
