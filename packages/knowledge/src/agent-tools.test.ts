import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import type { KnowledgeDoc, RunContext } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createKnowledgeTools, VENDO_KNOWLEDGE_SEARCH_TOOL } from "./index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "u1" },
  venue: "chat",
  presence: "present",
  sessionId: "s1",
};

const docs: KnowledgeDoc[] = [
  {
    id: "doc-transfers",
    kind: "docs",
    visibility: "public",
    title: "Wire transfer limits",
    text: "Maple caps outbound wire transfers at $25,000 per business day. Limits reset at midnight ET.",
    source: "docs/transfers.md",
  },
  {
    id: "glossary-apy",
    kind: "glossary",
    visibility: "public",
    title: "APY",
    text: "APY (annual percentage yield) is the effective annual rate of return accounting for compounding.",
    source: "glossary/apy.md",
  },
];

describe("createKnowledgeTools descriptor (K1 pin)", () => {
  it("exposes exactly the pinned vendo_knowledge_search descriptor", async () => {
    const registry = createKnowledgeTools(memoryKnowledgeAdapter({ docs }));
    const descriptors = await registry.descriptors();
    expect(descriptors).toHaveLength(1);
    const descriptor = descriptors[0]!;
    expect(descriptor.name).toBe(VENDO_KNOWLEDGE_SEARCH_TOOL);
    expect(descriptor.name).toBe("vendo_knowledge_search");
    expect(descriptor.risk).toBe("read");
    const schema = descriptor.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["lookup", "query", "readMore"]);
    expect(schema.required).toEqual(["query"]);
  });
});

describe("vendo_knowledge_search execute (walking skeleton)", () => {
  it("answers a chat query with mapped hits in the pinned envelope", async () => {
    const registry = createKnowledgeTools(memoryKnowledgeAdapter({ docs }));
    const outcome = await registry.execute(
      { id: "call_1", tool: VENDO_KNOWLEDGE_SEARCH_TOOL, args: { query: "wire transfers" } },
      ctx,
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const output = outcome.output as {
      kind: string;
      outcome: string;
      hits: Array<Record<string, unknown>>;
    };
    expect(output.kind).toBe("vendo/knowledge-result@1");
    expect(output.outcome).toBe("answered");
    expect(output.hits).toHaveLength(1);
    expect(output.hits[0]).toMatchObject({
      docId: "doc-transfers",
      title: "Wire transfer limits",
      source: "docs/transfers.md",
      kind: "docs",
    });
    expect(typeof output.hits[0]!["snippet"]).toBe("string");
  });

  it("rejects an unknown tool name with not-found", async () => {
    const registry = createKnowledgeTools(memoryKnowledgeAdapter({ docs }));
    const outcome = await registry.execute({ id: "call_2", tool: "vendo_other", args: {} }, ctx);
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.error.code).toBe("not-found");
  });

  it("rejects a missing query with a validation error", async () => {
    const registry = createKnowledgeTools(memoryKnowledgeAdapter({ docs }));
    const outcome = await registry.execute({ id: "call_3", tool: VENDO_KNOWLEDGE_SEARCH_TOOL, args: {} }, ctx);
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.error.code).toBe("validation");
  });
});
