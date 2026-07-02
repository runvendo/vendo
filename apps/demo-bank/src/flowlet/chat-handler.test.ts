import { describe, it, expect } from "vitest";
import type { FlowletAgent } from "@flowlet/core";
import type { RunInput } from "@flowlet/core";
import { createDemoAgent } from "./agent";
import { handleChat } from "./chat-handler";
import { mockRenderModel, stubComposioClient } from "./_test-helpers";

describe("handleChat", () => {
  it("returns a streamed response containing a data-ui event", async () => {
    const agent = createDemoAgent({
      model: mockRenderModel(),
      composioClient: stubComposioClient,
    });

    const req = new Request("http://localhost/api/flowlet/chat", {
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

    const req = new Request("http://localhost/api/flowlet/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    const res = await handleChat(req, agent);
    expect(res.status).toBe(400);
  });

  it("rejects a non-array messages payload with 400", async () => {
    const agent = createDemoAgent({
      model: mockRenderModel(),
      composioClient: stubComposioClient,
    });

    for (const messages of [{}, "hi", 42, null]) {
      const req = new Request("http://localhost/api/flowlet/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      const res = await handleChat(req, agent);
      expect(res.status).toBe(400);
    }
  });

  it("registers Maple's host-API tools through the caller seam (ENG-202)", async () => {
    let seen: RunInput | undefined;
    const agent: FlowletAgent = {
      run: (input) => {
        seen = input;
        return new ReadableStream({ start: (c) => c.close() });
      },
    };

    const req = new Request("http://localhost/api/flowlet/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
    });
    await handleChat(req, agent);

    const tools = seen!.tools;
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["listAccounts", "listTransactions", "createOrder"]),
    );
    // Host tools are client-executed: no server execute, marked for the client wrapper.
    expect(tools["createOrder"]!.execute).toBeUndefined();
    expect((tools["createOrder"] as Record<string, unknown>)["flowletExecutor"]).toBe("client");
  });
});
