import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_WIRE_PATHS,
  KNOWLEDGE_WIRE_STATUS_BY_CODE,
  VENDO_KNOWLEDGE_WIRE_FORMAT,
  VendoError,
  knowledgeWireErrorBody,
  knowledgeWireErrorSchema,
  knowledgeWireFetchRequestSchema,
  knowledgeWireRemoveRequestSchema,
  knowledgeWireSearchRequestSchema,
  knowledgeWireStatusSchema,
  knowledgeWireUpsertRequestSchema,
  parseKnowledgeWireError,
  type KnowledgeWireStatus,
} from "./index.js";

describe("vendo/knowledge-wire@1", () => {
  it("exposes the format constant and the five mount-relative paths", () => {
    expect(VENDO_KNOWLEDGE_WIRE_FORMAT).toBe("vendo/knowledge-wire@1");
    expect(KNOWLEDGE_WIRE_PATHS).toEqual({
      search: "/search",
      fetch: "/fetch",
      upsert: "/upsert",
      remove: "/remove",
      status: "/status",
    });
  });

  it("parses the four request DTOs and rejects tenant-smelling extras only via schema rules", () => {
    expect(knowledgeWireSearchRequestSchema.parse({
      query: { text: "refunds", intent: "chat" },
      includeInternal: true,
    }).includeInternal).toBe(true);
    expect(knowledgeWireSearchRequestSchema.safeParse({ query: { text: "" } }).success).toBe(false);
    expect(knowledgeWireFetchRequestSchema.parse({ ref: { docId: "doc_1", chunkId: "doc_1#2" } }).ref.docId).toBe("doc_1");
    expect(knowledgeWireFetchRequestSchema.safeParse({ ref: { chunkId: "no-doc-id" } }).success).toBe(false);
    expect(knowledgeWireUpsertRequestSchema.parse({
      docs: [{ id: "d1", kind: "docs", visibility: "public", title: "T", text: "body", source: "s.md" }],
    }).docs).toHaveLength(1);
    expect(knowledgeWireRemoveRequestSchema.safeParse({ docIds: [""] }).success).toBe(false);
  });

  it("status doubles as the discovery handshake: format + posture + counts", () => {
    const status: KnowledgeWireStatus = {
      format: VENDO_KNOWLEDGE_WIRE_FORMAT,
      posture: { fetch: true, write: true, visibility: "enforced" },
      status: { docs: 3, byKind: { docs: 2, glossary: 1 } },
    };
    expect(knowledgeWireStatusSchema.parse(status).posture.write).toBe(true);
    expect(knowledgeWireStatusSchema.safeParse({ ...status, format: "vendo/knowledge-wire@2" }).success).toBe(false);
  });

  it("maps every VendoError code to the wire status table and back", () => {
    const { status, body } = knowledgeWireErrorBody(new VendoError("not-found", "unknown ref"));
    expect(status).toBe(404);
    expect(knowledgeWireErrorSchema.parse(body).error.code).toBe("not-found");
    const roundTripped = parseKnowledgeWireError(status, body);
    expect(roundTripped).toBeInstanceOf(VendoError);
    expect(roundTripped.code).toBe("not-found");
    expect(roundTripped.message).toBe("unknown ref");
    expect(KNOWLEDGE_WIRE_STATUS_BY_CODE["cloud-required"]).toBe(402);
    expect(KNOWLEDGE_WIRE_STATUS_BY_CODE["validation"]).toBe(400);
  });

  it("parseKnowledgeWireError: enveloped code wins, bare statuses map, junk degrades honestly", () => {
    expect(parseKnowledgeWireError(400, { error: { code: "conflict", message: "id taken" } }).code).toBe("conflict");
    expect(parseKnowledgeWireError(402, undefined).code).toBe("cloud-required");
    expect(parseKnowledgeWireError(500, { error: { code: "not-a-real-code", message: "?" } }).code).toBe("not-implemented");
    expect(parseKnowledgeWireError(503, null).code).toBe("not-implemented");
  });

  it("only an enveloped not-found reads as document absence — a bare 404 surfaces as failure", () => {
    expect(parseKnowledgeWireError(404, { error: { code: "not-found", message: "unknown ref" } }).code).toBe("not-found");
    expect(parseKnowledgeWireError(404, "<html>nginx 404</html>").code).toBe("not-implemented");
    expect(parseKnowledgeWireError(404, undefined).code).toBe("not-implemented");
  });

  it("the reverse status table round-trips through the forward table", () => {
    for (const [status, code] of Object.entries({ 400: "validation", 402: "cloud-required", 403: "blocked", 409: "conflict" } as const)) {
      expect(KNOWLEDGE_WIRE_STATUS_BY_CODE[code]).toBe(Number(status));
      expect(parseKnowledgeWireError(Number(status), undefined).code).toBe(code);
    }
    expect(KNOWLEDGE_WIRE_STATUS_BY_CODE["not-found"]).toBe(404);
    expect(parseKnowledgeWireError(501, undefined).code).toBe("not-implemented");
  });
});
