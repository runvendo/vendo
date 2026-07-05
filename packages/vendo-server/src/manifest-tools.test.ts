import { describe, expect, it } from "vitest";
import type { ManifestTool } from "@vendoai/core";
import { manifestToolsToHostTools } from "./manifest-tools.js";

function tool(overrides: Partial<ManifestTool> = {}): ManifestTool {
  return {
    name: "get_account",
    description: "Get one account",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    annotations: { mutating: false, dangerous: false },
    binding: { type: "http", method: "GET", path: "/api/accounts/{id}" },
    ...overrides,
  };
}

describe("manifestToolsToHostTools", () => {
  it("maps a read tool: annotations, lowercase method, path param", () => {
    const [def] = manifestToolsToHostTools([tool()]);
    expect(def).toBeDefined();
    expect(def!.name).toBe("get_account");
    expect(def!.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(def!.http.method).toBe("get");
    expect(def!.http.path).toBe("/api/accounts/{id}");
    expect(def!.http.params).toEqual([{ name: "id", in: "path", required: true }]);
    expect(def!.http.hasBody).toBe(false);
  });

  it("splits schema properties into path params, query params and body", () => {
    const [def] = manifestToolsToHostTools([
      tool({
        name: "create_order",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            dryRun: { type: "boolean" },
            body: { type: "object", properties: { amount: { type: "number" } } },
          },
          required: ["id", "body"],
        },
        annotations: { mutating: true, dangerous: true },
        binding: { type: "http", method: "POST", path: "/api/orders/{id}" },
      }),
    ]);
    expect(def!.http.params).toEqual([
      { name: "id", in: "path", required: true },
      { name: "dryRun", in: "query", required: false },
    ]);
    expect(def!.http.hasBody).toBe(true);
    expect(def!.annotations.readOnlyHint).toBe(false);
    expect(def!.annotations.destructiveHint).toBe(true);
    // mutating + not declared idempotent → not idempotent
    expect(def!.annotations.idempotentHint).toBe(false);
  });

  it("respects an explicit idempotent annotation", () => {
    const [def] = manifestToolsToHostTools([
      tool({
        annotations: { mutating: true, dangerous: false, idempotent: true },
        binding: { type: "http", method: "PUT", path: "/api/accounts/{id}" },
      }),
    ]);
    expect(def!.annotations.idempotentHint).toBe(true);
  });

  it("keeps the input schema verbatim for the model", () => {
    const src = tool();
    const [def] = manifestToolsToHostTools([src]);
    expect(def!.inputSchema).toEqual(src.inputSchema);
  });

  it("throws when a path template param is missing from the input schema", () => {
    expect(() =>
      manifestToolsToHostTools([
        tool({
          inputSchema: { type: "object", properties: {} },
        }),
      ]),
    ).toThrow(/path parameter "id"/);
  });
});
