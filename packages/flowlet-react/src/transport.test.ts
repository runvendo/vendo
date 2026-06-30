import { describe, it, expect } from "vitest";
import { createStubAgent } from "@flowlet/core";
import { createLocalTransport } from "./transport";

describe("local transport", () => {
  it("drives the stub agent and exposes a client-part sink", async () => {
    const agent = createStubAgent();
    const { transport, sendClientPart } = createLocalTransport(agent);

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "c1",
      messageId: undefined,
      messages: [],
      abortSignal: new AbortController().signal,
    } as any);

    const reader = stream.getReader();
    const seen: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push((value as any).type);
      if ((value as any).type === "data-approval") {
        sendClientPart({ type: "data-approval-response", data: { approvalId: (value as any).data.approvalId, approved: true } });
      }
    }
    expect(seen).toContain("data-approval");
    expect(seen).toContain("data-ui");
  });
});
