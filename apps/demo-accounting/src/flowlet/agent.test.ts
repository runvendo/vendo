import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { createDemoAgent } from "./agent";
import { handleChat } from "./chat-handler";
import { stubComposioClient, ZERO_USAGE } from "./_test-helpers";
import { CADENCE_SCOPE, demoStore, resolveThreadRecordId } from "./store";

describe("createDemoAgent onSettled wiring", () => {
  it("REGRESSION: persists the streamed turn (incl. an approval-requested part) before any consent POST arrives", async () => {
    // Guards the exact failing sequence ENG-193 review (2026-07-04) caught on
    // packages/flowlet-next: if only the client-SENT messages were persisted,
    // the streamed assistant turn — carrying the approval-requested part the
    // consent endpoint reads — is missing from the store. createDemoAgent's
    // onSettled hook (agent.ts) must be the thing that writes it.
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Sending." },
            { type: "text-end", id: "t1" },
            { type: "tool-call", toolCallId: "call-1", toolName: "send_test_email", input: "{}" },
            { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
          ],
        }),
      }),
    });
    const agent = createDemoAgent({
      model,
      composioClient: stubComposioClient,
      extraTools: {
        send_test_email: {
          description: "send a test email",
          inputSchema: z.object({}),
          annotations: { destructiveHint: false },
          execute: async () => "ok",
        } as never,
      },
    });

    const req = new Request("http://localhost/api/flowlet/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "conv-regress",
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "send it" }] }],
      }),
    });

    const res = await handleChat(req, agent);
    expect(res.status).toBe(200);
    await res.text(); // drain the stream so the run settles

    // Persistence is fire-and-forget off the engine's onSettled — wait for it.
    const threadId = await resolveThreadRecordId(CADENCE_SCOPE, "conv-regress");
    await vi.waitFor(async () => {
      const stored = await demoStore.threads.getMessages(CADENCE_SCOPE, threadId);
      expect(stored.length).toBeGreaterThanOrEqual(2); // user turn + streamed assistant turn
      // The stored assistant turn must carry the PAUSED approval part itself —
      // state "approval-requested" for the gated tool call — because that part
      // is exactly what the consent endpoint looks up by toolCallId.
      const parts = stored
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.parts as Array<{ type: string; toolCallId?: string; state?: string }>);
      const approvalPart = parts.find((p) => p.toolCallId === "call-1");
      expect(approvalPart?.type).toBe("tool-send_test_email");
      expect(approvalPart?.state).toBe("approval-requested");
    });
  });
});
