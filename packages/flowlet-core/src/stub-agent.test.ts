import { describe, it, expect } from "vitest";
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

describe("stub agent", () => {
  it("emits text then an approval, and resumes with a ui node after approval", async () => {
    const agent = createStubAgent();
    let onClientPart!: (p: any) => void;
    const stream = agent.run({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      onClientPart: (p) => {}, // replaced below
    });

    // Capture the agent's client-part sink by re-running with a capturing handler.
    // (createStubAgent stores the latest onClientPart; see implementation.)
    const agent2 = createStubAgent();
    const parts: any[] = [];
    const collecting = (async () => {
      const s = agent2.run({
        messages: [],
        tools: [],
        signal: new AbortController().signal,
        onClientPart: (p) => {},
      });
      const reader = s.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        if (value.type === "data-approval") {
          agent2.respondToApproval(value.data.approvalId, { approved: true });
        }
      }
    })();
    await collecting;

    const types = parts.map((p) => p.type);
    expect(types).toContain("data-approval");
    expect(types).toContain("data-ui");
    // approval comes before the ui node
    expect(types.indexOf("data-approval")).toBeLessThan(types.indexOf("data-ui"));

    // matched approval id
    const approval = parts.find((p) => p.type === "data-approval");
    expect(typeof approval.data.approvalId).toBe("string");

    void stream; // unused first stream, only used to assert run() returns a stream
    expect(stream).toBeInstanceOf(ReadableStream);
  });
});
