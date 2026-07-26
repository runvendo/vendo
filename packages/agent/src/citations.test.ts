import {
  VENDO_KNOWLEDGE_RESULT_KIND,
  vendoCitationsPartSchema,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import { ctx, readSse, scriptedModel, testGuard, textTurn, toolCallTurn } from "./test-helpers.js";

const descriptor: ToolDescriptor = {
  name: "vendo_knowledge_search",
  description: "Search the product knowledge base.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  risk: "read",
};

/** A knowledge registry double: the bridge keys on the ENVELOPE in the
 *  ok-output, so the test needs no @vendoai/knowledge dependency (the agent
 *  block layers on core only). */
function knowledgeRegistry(output: unknown): ToolRegistry {
  return {
    async descriptors() {
      return [descriptor];
    },
    async execute(): Promise<ToolOutcome> {
      return { status: "ok", output: output as never };
    },
  };
}

async function citationsPartsFor(output: unknown): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const agent = createAgent({
    model: scriptedModel([
      toolCallTurn(descriptor.name, { query: "wire transfer limits" }, "call_knowledge"),
      textTurn("Here is what the docs say.", "text_knowledge"),
    ]),
    tools: knowledgeRegistry(output),
    guard: testGuard({}),
    // A tight cap proves the part bypasses capOutcome: the ok-output gets
    // truncated for the model while the citations part arrives whole.
    context: { toolOutputCap: 64 },
  });
  const response = await agent.stream({
    threadId: "thr_citations",
    message: { id: "user_1", role: "user", parts: [{ type: "text", text: "What are the wire limits?" }] },
    ctx: ctx(),
  });
  const { parts } = await readSse(response);
  return parts.filter((part) => (part as { type?: string }).type === "data-vendo-citations") as never;
}

describe("agent citations bridge (Knowledge K1)", () => {
  it("carries data-vendo-citations with the pinned payload for a grounded answer, past the output cap", async () => {
    const citation = {
      docId: "doc-transfers",
      chunkId: "doc-transfers#0",
      title: "Wire transfer limits",
      source: "docs/transfers.md",
      kind: "docs",
      visibility: "public",
      snippet: "Maple caps outbound wire transfers at $25,000 per business day. Limits reset at midnight ET.",
    };
    const found = await citationsPartsFor({
      kind: VENDO_KNOWLEDGE_RESULT_KIND,
      outcome: "answered",
      hits: [citation],
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.data).toMatchObject({
      toolCallId: "call_knowledge",
      outcome: "answered",
      citations: [citation],
    });
    expect(
      vendoCitationsPartSchema.safeParse({ type: "data-vendo-citations", ...found[0]!.data }).success,
    ).toBe(true);
  });

  it("carries the insufficient-evidence outcome for a refusal (weak hits included)", async () => {
    const found = await citationsPartsFor({
      kind: VENDO_KNOWLEDGE_RESULT_KIND,
      outcome: "insufficient-evidence",
      hits: [],
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.data).toMatchObject({
      toolCallId: "call_knowledge",
      outcome: "insufficient-evidence",
      citations: [],
    });
  });

  it("carries the unavailable outcome for an engine outage", async () => {
    const found = await citationsPartsFor({
      kind: VENDO_KNOWLEDGE_RESULT_KIND,
      outcome: "unavailable",
      hits: [],
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.data).toMatchObject({ outcome: "unavailable", citations: [] });
  });

  it("falls back to the docId when a hit carries no title", async () => {
    const found = await citationsPartsFor({
      kind: VENDO_KNOWLEDGE_RESULT_KIND,
      outcome: "answered",
      hits: [{ docId: "doc-untitled", kind: "docs", visibility: "public", snippet: "snippet" }],
    });
    expect(found).toHaveLength(1);
    expect((found[0]!.data.citations as Array<Record<string, unknown>>)[0]).toMatchObject({
      docId: "doc-untitled",
      title: "doc-untitled",
      visibility: "public",
    });
  });

  it("writes NO part when an answered result's only hit is malformed", async () => {
    // The pin (checker round 1 amendment) requires visibility on every
    // citation; with nothing valid left there is no citation surface.
    const found = await citationsPartsFor({
      kind: VENDO_KNOWLEDGE_RESULT_KIND,
      outcome: "answered",
      hits: [{ docId: "doc-x", title: "X", kind: "docs", snippet: "s" }],
    });
    expect(found).toHaveLength(0);
  });

  it("fail-soft: one malformed hit drops only itself — the valid citations still ride", async () => {
    // AI-review finding: a nonconforming BYO engine emitting ONE bad hit must
    // not silently strip the whole citation surface from a grounded answer.
    const valid = (docId: string) => ({
      docId,
      title: `Doc ${docId}`,
      kind: "docs",
      visibility: "public",
      snippet: "snippet",
    });
    const found = await citationsPartsFor({
      kind: VENDO_KNOWLEDGE_RESULT_KIND,
      outcome: "answered",
      hits: [
        valid("doc-a"),
        { docId: "doc-bad", title: "Bad", kind: "docs", snippet: "s" }, // no visibility
        valid("doc-b"),
      ],
    });
    expect(found).toHaveLength(1);
    const citations = found[0]!.data.citations as Array<Record<string, unknown>>;
    expect(citations.map((citation) => citation.docId)).toEqual(["doc-a", "doc-b"]);
  });

  it("writes NO citations part for model-facing-only results", async () => {
    // A schema/readMore miss and a read-more text result render nothing.
    expect(await citationsPartsFor({ kind: VENDO_KNOWLEDGE_RESULT_KIND, outcome: "not-found" })).toHaveLength(0);
    expect(await citationsPartsFor({ kind: VENDO_KNOWLEDGE_RESULT_KIND, outcome: "answered", text: "full doc" })).toHaveLength(0);
    // An ordinary tool output never triggers the knowledge branch.
    expect(await citationsPartsFor({ rows: [1, 2, 3] })).toHaveLength(0);
  });
});
