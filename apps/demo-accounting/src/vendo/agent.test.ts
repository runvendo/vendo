import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { createDemoAgent } from "./agent";
import { handleChat } from "./chat-handler";
import { handleDemoConsent } from "./consent-handler";
import { stubComposioClient, ZERO_USAGE } from "./_test-helpers";
import { CADENCE_SCOPE, demoStore, resolveThreadRecordId } from "./store";

describe("createDemoAgent onSettled wiring", () => {
  it("REGRESSION: persists the streamed turn (incl. an approval-requested part) before any consent POST arrives", async () => {
    // Guards the exact failing sequence ENG-193 review (2026-07-04) caught on
    // the handler package (now packages/vendo-server): if only the
    // client-SENT messages were persisted,
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

    const req = new Request("http://localhost/api/vendo/chat", {
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

  it("REGRESSION: an approval streamed on a CONTINUATION turn is persisted, so consent mints its grant (live-verification 2026-07-04)", async () => {
    // The live failing sequence: turn 1 settles [user, assistant@v1]; turn 2
    // is a continuation (the transport resubmits ending with that assistant
    // message, and ai's onFinish returns [...original.slice(0,-1), revised] —
    // the SAME length). The old prefix delta appended nothing, so the revised
    // message's approval-requested part never reached the store and the live
    // consent POST 404'd. `replaceMessages` must persist the revision.
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks:
            ++call === 1
              ? [
                  { type: "text-start", id: "t1" },
                  { type: "text-delta", id: "t1", delta: "Looked it up." },
                  { type: "text-end", id: "t1" },
                  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
                ]
              : [
                  { type: "tool-call", toolCallId: "call-cont", toolName: "SEND_TEST_EMAIL", input: "{}" },
                  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
                ],
        }),
      }),
    });
    const agent = createDemoAgent({
      model,
      composioClient: stubComposioClient,
      extraTools: {
        SEND_TEST_EMAIL: {
          description: "send a test email",
          inputSchema: z.object({}),
          annotations: { destructiveHint: false },
          execute: async () => "ok",
        } as never,
      },
    });
    const chatReq = (messages: unknown[]) =>
      new Request("http://localhost/api/vendo/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "conv-cont", messages }),
      });
    const user = { id: "u1", role: "user", parts: [{ type: "text", text: "send it" }] };

    // Turn 1: plain text — settles [user, assistant@v1].
    await (await handleChat(chatReq([user]), agent)).text();
    const threadId = await resolveThreadRecordId(CADENCE_SCOPE, "conv-cont");
    let assistant: unknown;
    await vi.waitFor(async () => {
      const stored = await demoStore.threads.getMessages(CADENCE_SCOPE, threadId);
      expect(stored).toHaveLength(2);
      assistant = stored[1];
    });

    // Turn 2: resubmit ending with the stored assistant message — exactly what
    // DefaultChatTransport does on a continuation. The gated call pauses.
    await (await handleChat(chatReq([user, assistant]), agent)).text();
    await vi.waitFor(async () => {
      const stored = await demoStore.threads.getMessages(CADENCE_SCOPE, threadId);
      expect(stored).toHaveLength(2); // the assistant message was REVISED, not appended
      const parts = stored[1]!.parts as Array<{ type: string; toolCallId?: string; state?: string }>;
      expect(parts.find((p) => p.toolCallId === "call-cont")?.state).toBe("approval-requested");
    });

    const consentRes = await handleDemoConsent(
      new Request("http://localhost/api/vendo/consent", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost" },
        body: JSON.stringify({
          id: "conv-cont",
          toolCallId: "call-cont",
          toolName: "SEND_TEST_EMAIL",
          response: {
            id: "call-cont",
            decision: "yes",
            grant: { tool: "SEND_TEST_EMAIL", scope: { kind: "tool" }, duration: "standing" },
          },
        }),
      }),
    );
    expect(consentRes.status).toBe(200);
    expect(await demoStore.grants.findForTool(CADENCE_SCOPE, "SEND_TEST_EMAIL")).toHaveLength(1);
  });
});
