import { describe, it, expect } from "vitest";
import { createStubAgent } from "./stub-agent";

describe("stub agent", () => {
  it("emits text then an approval, and resumes with a ui node after approval", async () => {
    const agent = createStubAgent();
    const parts: any[] = [];
    const reader = agent
      .run({
        messages: [],
        tools: [],
        signal: new AbortController().signal,
        onClientPart: (p) => {},
      })
      .getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      if (value.type === "data-approval") {
        agent.respondToApproval(value.data.approvalId, { approved: true });
      }
    }

    const types = parts.map((p) => p.type);
    expect(types).toContain("data-approval");
    expect(types).toContain("data-ui");
    // approval comes before the ui node
    expect(types.indexOf("data-approval")).toBeLessThan(types.indexOf("data-ui"));

    // matched approval id
    const approval = parts.find((p) => p.type === "data-approval");
    expect(typeof approval.data.approvalId).toBe("string");
  });

  it("cancels via AbortSignal while awaiting approval and never emits a ui node", async () => {
    const agent = createStubAgent();
    const controller = new AbortController();
    const stream = agent.run({
      messages: [],
      tools: [],
      signal: controller.signal,
      onClientPart: (p) => {},
    });

    const parts: any[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      if (value.type === "data-approval") {
        // Abort instead of approving — the run should short-circuit.
        controller.abort();
      }
    }

    const types = parts.map((p) => p.type);
    expect(types).toContain("data-approval");
    expect(types).not.toContain("data-ui");
  });
});
