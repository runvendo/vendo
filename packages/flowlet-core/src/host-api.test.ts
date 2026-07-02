import { describe, expect, it, vi } from "vitest";
import {
  openApiToHostTools,
  executeHostToolCall,
  type HostToolDefinition,
} from "./host-api";

/** Minimal OpenAPI 3.1 fixture exercising every adapter rule. */
const spec = {
  openapi: "3.1.0",
  info: { title: "Maple API", version: "1.0.0" },
  paths: {
    "/api/accounts": {
      get: {
        operationId: "listAccounts",
        summary: "List all accounts",
      },
    },
    "/api/accounts/{id}": {
      get: {
        operationId: "getAccount",
        description: "Fetch one account by id.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Account id",
          },
        ],
      },
    },
    "/api/transactions": {
      get: {
        operationId: "listTransactions",
        summary: "List transactions",
        parameters: [
          { name: "limit", in: "query", schema: { type: "number" } },
          { name: "search", in: "query", schema: { type: "string" } },
        ],
      },
    },
    "/api/orders": {
      post: {
        operationId: "createOrder",
        summary: "Place a delivery order",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  merchant: { type: "string" },
                  amountCents: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
    "/api/payees/{id}": {
      delete: {
        operationId: "deletePayee",
        summary: "Remove a payee",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
      },
    },
    "/api/transfers": {
      post: {
        operationId: "createTransfer",
        summary: "Move money between accounts",
        "x-flowlet-dangerous": true,
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { amountCents: { type: "number" } } },
            },
          },
        },
      },
    },
    "/api/ping": {
      get: { summary: "Ping" }, // no operationId → derived name
    },
  },
} as const;

function byName(defs: HostToolDefinition[], name: string): HostToolDefinition {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`missing tool: ${name}`);
  return def;
}

describe("openApiToHostTools", () => {
  const defs = openApiToHostTools(spec);

  it("produces one definition per operation, named by operationId", () => {
    expect(defs.map((d) => d.name).sort()).toEqual(
      [
        "listAccounts",
        "getAccount",
        "listTransactions",
        "createOrder",
        "deletePayee",
        "createTransfer",
        "get_api_ping",
      ].sort(),
    );
  });

  it("derives a name from method + path when operationId is missing", () => {
    const ping = byName(defs, "get_api_ping");
    expect(ping.http).toEqual({ method: "get", path: "/api/ping", params: [], hasBody: false });
  });

  it("uses summary (or description) as the tool description", () => {
    expect(byName(defs, "listAccounts").description).toBe("List all accounts");
    expect(byName(defs, "getAccount").description).toBe("Fetch one account by id.");
  });

  it("marks GET operations read-only and not destructive", () => {
    expect(byName(defs, "listAccounts").annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("marks POST operations mutating (not read-only, gated by fail-safe)", () => {
    expect(byName(defs, "createOrder").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("marks DELETE operations destructive", () => {
    const ann = byName(defs, "deletePayee").annotations;
    expect(ann.destructiveHint).toBe(true);
    expect(ann.readOnlyHint).toBe(false);
  });

  it("honours the x-flowlet-dangerous extension", () => {
    expect(byName(defs, "createTransfer").annotations.destructiveHint).toBe(true);
  });

  it("builds a flat input schema: params top-level, request body under `body`", () => {
    const order = byName(defs, "createOrder");
    expect(order.inputSchema).toEqual({
      type: "object",
      properties: {
        body: {
          type: "object",
          properties: {
            merchant: { type: "string" },
            amountCents: { type: "number" },
          },
        },
      },
      required: ["body"],
      additionalProperties: false,
    });

    const txns = byName(defs, "listTransactions");
    expect(txns.inputSchema).toEqual({
      type: "object",
      properties: {
        limit: { type: "number" },
        search: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    });

    const account = byName(defs, "getAccount");
    expect(account.inputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "string", description: "Account id" },
      },
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("records HTTP call metadata with parameter locations", () => {
    expect(byName(defs, "getAccount").http).toEqual({
      method: "get",
      path: "/api/accounts/{id}",
      params: [{ name: "id", in: "path", required: true }],
      hasBody: false,
    });
    expect(byName(defs, "createOrder").http).toEqual({
      method: "post",
      path: "/api/orders",
      params: [],
      hasBody: true,
    });
  });
});

describe("executeHostToolCall", () => {
  function jsonResponse(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const defs = openApiToHostTools(spec);

  it("performs a GET with path and query params on the user's session", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: [1] }));
    const result = await executeHostToolCall(
      byName(defs, "listTransactions"),
      { limit: 5, search: "uber" },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/transactions?limit=5&search=uber", {
      method: "GET",
      credentials: "include",
      headers: {},
      body: undefined,
    });
    expect(result).toEqual({ status: 200, ok: true, data: { data: [1] } });
  });

  it("substitutes and URL-encodes path parameters", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: {} }));
    await executeHostToolCall(byName(defs, "getAccount"), { id: "a/b 1" }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/accounts/a%2Fb%201",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("omits undefined query params", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    await executeHostToolCall(byName(defs, "listTransactions"), { limit: 3 }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/transactions?limit=3",
      expect.anything(),
    );
  });

  it("POSTs the body as JSON", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: { id: "txn_1" } }));
    const result = await executeHostToolCall(
      byName(defs, "createOrder"),
      { body: { merchant: "DoorDash", amountCents: 3184 } },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/orders", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchant: "DoorDash", amountCents: 3184 }),
    });
    expect(result).toEqual({ status: 200, ok: true, data: { data: { id: "txn_1" } } });
  });

  it("prefixes baseUrl when provided", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    await executeHostToolCall(byName(defs, "listAccounts"), {}, {
      fetchImpl,
      baseUrl: "https://bank.example",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://bank.example/api/accounts",
      expect.anything(),
    );
  });

  it("returns HTTP errors as structured data (the model can react)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { error: { message: "Account not found", code: "not_found" } }),
    );
    const result = await executeHostToolCall(byName(defs, "getAccount"), { id: "nope" }, { fetchImpl });
    expect(result).toEqual({
      status: 404,
      ok: false,
      data: { error: { message: "Account not found", code: "not_found" } },
    });
  });

  it("returns non-JSON responses as text", async () => {
    const fetchImpl = vi.fn(async () => new Response("plain", { status: 200 }));
    const result = await executeHostToolCall(byName(defs, "listAccounts"), {}, { fetchImpl });
    expect(result).toEqual({ status: 200, ok: true, data: "plain" });
  });

  it("throws when a required path parameter is missing", async () => {
    const fetchImpl = vi.fn();
    await expect(
      executeHostToolCall(byName(defs, "getAccount"), {}, { fetchImpl }),
    ).rejects.toThrow(/path parameter "id"/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
