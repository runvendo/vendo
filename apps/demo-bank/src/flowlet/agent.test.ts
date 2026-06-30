import { describe, it, expect } from "vitest";
import type { FlowletUIMessage } from "@flowlet/core";
import { createDemoAgent } from "./agent";
import { mockRenderModel, stubComposioClient } from "./_test-helpers";

async function collectChunks(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("createDemoAgent", () => {
  it("streams a data-ui node when the model calls render_ui", async () => {
    const agent = createDemoAgent({
      model: mockRenderModel(),
      composioClient: stubComposioClient,
    });

    const messages: FlowletUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Show me a view." }] },
    ];

    const stream = agent.run({
      messages,
      tools: {},
      principal: { userId: "flowlet-demo" },
      signal: new AbortController().signal,
    });

    const chunks = (await collectChunks(stream)) as { type?: string }[];
    expect(chunks.some((c) => c.type === "data-ui")).toBe(true);
  });
});
