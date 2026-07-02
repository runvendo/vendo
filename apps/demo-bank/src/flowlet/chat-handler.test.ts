import { describe, it, expect } from "vitest";
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
});
