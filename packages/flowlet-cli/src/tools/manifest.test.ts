import { describe, expect, it } from "vitest";
import { annotationsFor, toolsManifestSchema } from "./manifest.js";

describe("toolsManifestSchema", () => {
  it("accepts a well-formed manifest", () => {
    const m = {
      version: 1,
      extractedFrom: { kind: "openapi", path: "openapi.json" },
      tools: [{
        name: "list_transactions",
        description: "List transactions",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        http: { method: "get", path: "/api/transactions" },
        source: "openapi",
      }],
      events: [],
    };
    expect(toolsManifestSchema.parse(m)).toBeTruthy();
  });

  it("rejects bad tool names", () => {
    const bad = {
      version: 1,
      tools: [{ name: "Bad Name!", description: "x", inputSchema: {}, annotations: {}, source: "openapi" }],
      events: [],
    };
    expect(() => toolsManifestSchema.parse(bad)).toThrow();
  });
});

describe("annotationsFor", () => {
  it("marks reads read-only and deletes destructive", () => {
    expect(annotationsFor("get", "list_things")).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(annotationsFor("delete", "delete_payee")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(annotationsFor("post", "cancel_order")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotationsFor("post", "create_payment")).toEqual({ readOnlyHint: false, openWorldHint: false });
    expect(annotationsFor("put", "update_profile")).toMatchObject({ idempotentHint: true });
  });
});
