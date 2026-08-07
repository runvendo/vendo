import { describe, expect, it } from "vitest";
import { KNOWLEDGE_CHUNKS_COLLECTION, KNOWLEDGE_DOCS_COLLECTION } from "./index.js";

describe("@vendoai/knowledge scaffold", () => {
  it("names the store collections the local engine binds to (ENG-356 DDL)", () => {
    expect(KNOWLEDGE_DOCS_COLLECTION).toBe("vendo_knowledge_docs");
    expect(KNOWLEDGE_CHUNKS_COLLECTION).toBe("vendo_knowledge_chunks");
  });
});
