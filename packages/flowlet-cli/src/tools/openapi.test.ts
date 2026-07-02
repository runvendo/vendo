import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertOpenApi } from "./openapi.js";

const fixture = path.join(fileURLToPath(new URL(".", import.meta.url)), "../../test/fixtures/openapi/maple.json");

describe("convertOpenApi", () => {
  it("converts operations to tool entries with annotations", async () => {
    const tools = await convertOpenApi(fixture);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["list_transactions", "get_api_transactions_by_id", "create_payment", "delete_payee"]),
    );

    const list = tools.find((t) => t.name === "list_transactions")!;
    expect(list.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect((list.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty("limit");

    const del = tools.find((t) => t.name === "delete_payee")!;
    expect(del.annotations.destructiveHint).toBe(true);

    const create = tools.find((t) => t.name === "create_payment")!;
    // $ref resolved into the body property
    const body = (create.inputSchema as { properties: { body: { properties: Record<string, unknown> } } }).properties.body;
    expect(body.properties).toHaveProperty("amount");
    expect(create.http).toEqual({ method: "post", path: "/api/payments" });

    const byId = tools.find((t) => t.name === "get_api_transactions_by_id")!;
    expect((byId.inputSchema as { required?: string[] }).required).toContain("id");
  });
});
