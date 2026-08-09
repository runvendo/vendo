import { describe, expect, it } from "vitest";
import { KNOWLEDGE_CHUNKS_COLLECTION, KNOWLEDGE_DOCS_COLLECTION } from "../src/index.js";

describe("@vendoai/knowledge released collection names", () => {
  // Not a self-mirror: these two literals are a cross-repo constant. The
  // console imports them (vendo-web apps/console/tests/
  // knowledge-table-collision.test.ts) to prove its own knowledge tables never
  // collide, after an incident where both sides ran CREATE TABLE IF NOT EXISTS
  // for the same name against one hosted data-plane database. Changing either
  // string breaks the console, so it is pinned here and not only in the type.
  it("keeps the literals the console's collision guard is written against", () => {
    expect(KNOWLEDGE_DOCS_COLLECTION).toBe("vendo_knowledge_docs");
    expect(KNOWLEDGE_CHUNKS_COLLECTION).toBe("vendo_knowledge_chunks");
  });
});
