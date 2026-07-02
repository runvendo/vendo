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

describe("annotationsFor (fail closed)", () => {
  it("auto-allows only read-named GETs from a spec", () => {
    expect(annotationsFor("get", "list_things", "openapi")).toEqual({ mutating: false, dangerous: false });
    expect(annotationsFor("get", "get_profile", "openapi")).toEqual({ mutating: false, dangerous: false });
    // side-effect-shaped GETs fail closed (demo-bank's poll GET fires Slack,
    // its integrations GET calls connect())
    expect(annotationsFor("get", "poll_flowlet", "openapi")).toEqual({ mutating: true, dangerous: false });
    expect(annotationsFor("get", "connect_integration", "openapi")).toEqual({ mutating: true, dangerous: false });
    expect(annotationsFor("get", "reset_flowlet", "openapi")).toEqual({ mutating: true, dangerous: true });
  });

  it("never auto-allows a route-scan tool, even read-named GETs", () => {
    expect(annotationsFor("get", "list_transactions", "route-scan")).toEqual({ mutating: true, dangerous: false });
    expect(annotationsFor("get", "get_profile", "route-scan")).toEqual({ mutating: true, dangerous: false });
  });

  it("marks writes mutating and deletes/destructive names dangerous", () => {
    expect(annotationsFor("delete", "delete_payee", "openapi")).toEqual({ mutating: true, dangerous: true, idempotent: true });
    expect(annotationsFor("post", "cancel_order", "openapi")).toEqual({ mutating: true, dangerous: true });
    expect(annotationsFor("post", "create_payment", "openapi")).toEqual({ mutating: true, dangerous: false });
    expect(annotationsFor("put", "update_profile", "openapi")).toEqual({ mutating: true, dangerous: false, idempotent: true });
  });
});
