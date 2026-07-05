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
  it("streams a data-ui node when the model calls render_view", async () => {
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

// Pre-migration baseline: the exact prompt shipped before the shared prompt
// core (docs/superpowers/specs/2026-07-04-context-engineering-design.md).
// The migration diff test anchors on this fixture — regenerate ONLY with an
// intentional, reviewed prompt change (UPDATE_PROMPT_BASELINE=1 pnpm test).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildInstructions } from "./agent";

describe("chat prompt baseline", () => {
  const fixturePath = join(__dirname, "__fixtures__", "chat-instructions.baseline.txt");

  it("matches the frozen pre-migration fixture", () => {
    const current = buildInstructions();
    if (process.env.UPDATE_PROMPT_BASELINE) {
      writeFileSync(fixturePath, current);
    }
    expect(current).toBe(readFileSync(fixturePath, "utf8"));
  });
});
