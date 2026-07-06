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
      expect.arrayContaining(["getTransactions", "getTransactionsId", "postPayments", "deletePayeesId"]),
    );

    const list = tools.find((t) => t.name === "getTransactions")!;
    expect(list.annotations).toEqual({ mutating: false, dangerous: false });
    expect((list.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty("limit");

    const del = tools.find((t) => t.name === "deletePayeesId")!;
    expect(del.annotations).toEqual({ mutating: true, dangerous: true, idempotent: true });

    const create = tools.find((t) => t.name === "postPayments")!;
    // $ref resolved into the body property
    const body = (create.inputSchema as { properties: { body: { properties: Record<string, unknown> } } }).properties.body;
    expect(body.properties).toHaveProperty("amount");
    expect(create.binding).toEqual({ type: "http", method: "POST", path: "/api/payments" });

    const byId = tools.find((t) => t.name === "getTransactionsId")!;
    expect((byId.inputSchema as { required?: string[] }).required).toContain("id");
  });
});
