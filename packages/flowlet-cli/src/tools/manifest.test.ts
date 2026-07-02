import { describe, expect, it } from "vitest";
import { annotationsFor, toolsManifestSchema } from "./manifest.js";

describe("toolsManifestSchema (canonical, re-exported from @flowlet/core)", () => {
  it("accepts a well-formed manifest", () => {
    const m = {
      version: 1,
      tools: [{
        name: "list_transactions",
        description: "List transactions",
        inputSchema: { type: "object", properties: {} },
        annotations: { mutating: false, dangerous: false },
        binding: { type: "http", method: "GET", path: "/api/transactions" },
      }],
      events: [],
    };
    expect(toolsManifestSchema.parse(m)).toBeTruthy();
  });

  it("rejects unknown keys (strict contract)", () => {
    const bad = {
      version: 1,
      extractedFrom: { kind: "openapi", path: "openapi.json" },
      tools: [],
      events: [],
    };
    expect(() => toolsManifestSchema.parse(bad)).toThrow();
  });
});

describe("annotationsFor", () => {
  it("marks reads non-mutating and deletes dangerous+idempotent", () => {
    expect(annotationsFor("get", "list_things")).toEqual({ mutating: false, dangerous: false });
    expect(annotationsFor("delete", "delete_payee")).toEqual({ mutating: true, dangerous: true, idempotent: true });
    expect(annotationsFor("post", "cancel_order")).toEqual({ mutating: true, dangerous: true });
    expect(annotationsFor("post", "create_payment")).toEqual({ mutating: true, dangerous: false });
    expect(annotationsFor("put", "update_profile")).toEqual({ mutating: true, dangerous: false, idempotent: true });
  });
});
