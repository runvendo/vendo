import { describe, it, expect } from "vitest";
import type { VendoAgent, RunInput } from "@vendoai/core";
import { createDemoAgent } from "./agent";
import { handleChat } from "./chat-handler";
import { mockRenderModel, stubComposioClient } from "./_test-helpers";
import { CADENCE_SCOPE, demoStore, resolveThreadRecordId } from "./store";

describe("handleChat", () => {
  it("returns a streamed response containing a data-ui event", async () => {
    const agent = createDemoAgent({
      model: mockRenderModel(),
      composioClient: stubComposioClient,
    });

    const req = new Request("http://localhost/api/vendo/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Show me a view." }] }],
      }),
    });

    const res = await handleChat(req, agent);
    expect(res.ok).toBe(true);

    const text = await res.text();
    expect(text).toContain("data-ui");
  });

  it("rejects an empty-messages request with 400 instead of crashing the run", async () => {
    const agent = createDemoAgent({
      model: mockRenderModel(),
      composioClient: stubComposioClient,
    });

    for (const messages of [[], {}, "hi", 42, null]) {
      const req = new Request("http://localhost/api/vendo/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      const res = await handleChat(req, agent);
      expect(res.status).toBe(400);
    }
  });

  it("refuses non-local requests without the explicit public opt-in", async () => {
    const agent = createDemoAgent({
      model: mockRenderModel(),
      composioClient: stubComposioClient,
    });
    const req = new Request("https://cadence-preview.example.com/api/vendo/chat", {
      method: "POST",
      headers: { "content-type": "application/json", host: "cadence-preview.example.com" },
      body: JSON.stringify({
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
    });
    const res = await handleChat(req, agent);
    expect(res.status).toBe(403);
  });

  it("registers Cadence's host-API tools through the caller seam (ENG-202)", async () => {
    let seen: RunInput | undefined;
    const agent: VendoAgent = {
      run: (input) => {
        seen = input;
        return new ReadableStream({ start: (c) => c.close() });
      },
    };

    const req = new Request("http://localhost/api/vendo/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
    });
    await handleChat(req, agent);

    const tools = seen!.tools;
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["listClients", "listDeadlines", "sendClientMessage", "setDocumentStatus"]),
    );
    // Host tools are client-executed: no server execute, marked for the client wrapper.
    expect(tools["sendClientMessage"]!.execute).toBeUndefined();
    expect((tools["sendClientMessage"] as Record<string, unknown>)["vendoExecutor"]).toBe("client");
    // The demo controls never reach the model.
    expect(Object.keys(tools)).not.toContain("resetDemo");
  });

  it("does NOT persist messages itself — the engine's onSettled hook (wired in agent.ts) is the single writer", async () => {
    // The old design persisted the client-SENT messages here, which meant the
    // STREAMED assistant turn (carrying any approval-requested parts) was
    // missing from the store when a consent POST arrived (ENG-193 review
    // 2026-07-04, mirrors packages/vendo-server's chat.ts fix). Chat now only
    // resolves the thread id; createDemoAgent's onSettled hook (agent.ts) is
    // the sole writer — see agent.test.ts for that regression coverage.
    const agent: VendoAgent = { run: () => new ReadableStream({ start: (c) => c.close() }) };
    const req = new Request("http://localhost/api/vendo/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "conv-no-persist",
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
    });
    await handleChat(req, agent);
    const threadId = await resolveThreadRecordId(CADENCE_SCOPE, "conv-no-persist");
    expect(await demoStore.threads.getMessages(CADENCE_SCOPE, threadId)).toEqual([]);
  });

  it("passes the resolved store thread id into agent.run as threadId", async () => {
    let seen: RunInput | undefined;
    const agent: VendoAgent = {
      run: (input) => {
        seen = input;
        return new ReadableStream({ start: (c) => c.close() });
      },
    };
    const req = new Request("http://localhost/api/vendo/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "conv-threadid",
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
    });
    await handleChat(req, agent);
    const expected = await resolveThreadRecordId(CADENCE_SCOPE, "conv-threadid");
    expect(seen!.threadId).toBe(expected);
  });
});
