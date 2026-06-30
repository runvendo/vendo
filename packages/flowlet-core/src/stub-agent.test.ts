import { describe, it, expect } from "vitest";
import type { FlowletUIMessage } from "./protocol";
import { createStubAgent } from "./stub-agent";

async function collect(stream: ReadableStream<any>): Promise<any[]> {
  const out: any[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const userTurn: FlowletUIMessage[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "show me a card" }] },
];

describe("stub agent (native ai SDK HITL)", () => {
  it("turn 1 streams text + a tool-approval-request, and no ui node yet", async () => {
    const agent = createStubAgent();
    const parts = await collect(
      agent.run({ messages: userTurn, tools: {}, signal: new AbortController().signal }),
    );
    const types = parts.map((p) => p.type);

    // assistant streamed some text
    expect(types).toContain("text-delta");
    // the SDK paused on the needsApproval tool
    expect(types).toContain("tool-approval-request");
    // no UI node is rendered until the tool is approved + executed
    expect(types).not.toContain("data-ui");
    // run identity rides as message metadata on the start chunk (no data-run part)
    expect(types).not.toContain("data-run");
    const start = parts.find((p) => p.type === "start") as
      | { messageMetadata?: { runId: string; schemaVersion: number } }
      | undefined;
    expect(start?.messageMetadata?.runId).toBe("run-1");
    expect(start?.messageMetadata?.schemaVersion).toBe(1);
  });

  it("cancels via AbortSignal without emitting a ui node", async () => {
    const agent = createStubAgent();
    const controller = new AbortController();
    controller.abort();
    const parts = await collect(
      agent.run({ messages: userTurn, tools: {}, signal: controller.signal }),
    );
    expect(parts.map((p) => p.type)).not.toContain("data-ui");
  });
});
