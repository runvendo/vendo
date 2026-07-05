import { describe, it, expect } from "vitest";
import { type VendoUIMessage } from "@vendoai/core";
import { createStubAgent } from "@vendoai/core/testing";
import { createLocalTransport } from "./transport.js";

describe("local transport", () => {
  it("drives the agent for a turn and streams a tool-approval-request", async () => {
    const agent = createStubAgent();
    const { transport } = createLocalTransport(agent);

    const messages: VendoUIMessage[] = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "show me a card" }] },
    ];
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "c1",
      messageId: undefined,
      messages,
      abortSignal: new AbortController().signal,
    });

    const reader = stream.getReader();
    const seen: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push((value as { type: string }).type);
    }
    // Turn 1: the SDK pauses on the needsApproval tool; no ui node until approval.
    expect(seen).toContain("tool-approval-request");
    expect(seen).not.toContain("data-ui");
  });
});
