import type { ExtractedTool } from "@vendoai/actions";
import { describe, expect, it } from "vitest";
import { VENDO_FIXTURES_FORMAT, type FixturesFile } from "../../../src/cli/try/profile.js";
import { createSyntheticFetch } from "../../../src/cli/try/synthetic-fetch.js";

/** The same shapes deterministic extraction emits into `.vendo/tools.json`
 *  (see examples/demo-bank/.vendo/tools.json): route and openapi bindings carry
 *  method + `{param}` path templates; executeHost substitutes the params and
 *  issues `<baseUrl><path>` — the synthetic fetch must invert exactly that. */
const tools: ExtractedTool[] = [
  {
    name: "host_invoices_list",
    description: "GET /api/invoices",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
  },
  {
    name: "host_invoices_get",
    description: "GET /api/invoices/{id}",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: true },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/api/invoices/{id}", argsIn: "query" },
  },
  {
    name: "host_accounts_list",
    description: "GET /api/accounts",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/api/accounts", argsIn: "query" },
  },
  {
    name: "host_createOrder",
    description: "Place an order",
    inputSchema: { type: "object", properties: { body: { type: "object" } }, required: ["body"] },
    risk: "write",
    binding: { kind: "openapi", operationId: "createOrder", method: "POST", path: "/api/orders" },
  },
];

const fixtures: FixturesFile = {
  format: VENDO_FIXTURES_FORMAT,
  fixtures: {
    host_invoices_list: [{ id: "inv_1", total: 120 }, { id: "inv_2", total: 45 }],
    host_invoices_get: [{ id: "inv_1", total: 120 }, { id: "inv_2", total: 45 }],
    // A key naming no extracted tool: harmless, no route ever reaches it.
    host_ghost_list: [{ id: "ghost_1" }],
  },
};

const syntheticFetch = createSyntheticFetch({ tools, fixtures });

async function body(response: Response): Promise<unknown> {
  expect(response.headers.get("content-type")).toBe("application/json");
  return response.json();
}

describe("createSyntheticFetch", () => {
  it("answers a GET matching an exact path with the tool's fixture rows", async () => {
    const response = await syntheticFetch("https://host.example/api/invoices", { method: "GET" });
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual([{ id: "inv_1", total: 120 }, { id: "inv_2", total: 45 }]);
  });

  it("matches a {param} path segment and answers single-item shaped: the first row", async () => {
    const response = await syntheticFetch("https://host.example/api/invoices/inv_2", { method: "GET" });
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ id: "inv_1", total: 120 });
  });

  it("answers [] for a GET tool without fixture rows", async () => {
    const response = await syntheticFetch("https://host.example/api/accounts", { method: "GET" });
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual([]);
  });

  it("accepts the URL-object + init shape executeHost issues", async () => {
    const response = await syntheticFetch(new URL("https://host.example/api/invoices"), {
      method: "GET",
      headers: { accept: "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(fixtures.fixtures["host_invoices_list"]);
  });

  it("answers a matched write with { ok, synthetic } merged with the echoed request body", async () => {
    const response = await syntheticFetch("https://host.example/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: { merchant: "Acme Demo Co", amountCents: 3184 } }),
    });
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      ok: true,
      synthetic: true,
      body: { merchant: "Acme Demo Co", amountCents: 3184 },
    });
  });

  it("answers a matched write with a bodyless/non-object body as the bare success marker", async () => {
    const response = await syntheticFetch("https://host.example/api/orders", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ ok: true, synthetic: true });
  });

  it("answers 404 naming the path when no tool matches", async () => {
    const response = await syntheticFetch("https://host.example/api/unknown", { method: "GET" });
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({ error: "no synthetic route for GET /api/unknown" });
  });

  it("matches method as part of the route: a write verb on a read-only path is 404, not an echo", async () => {
    const response = await syntheticFetch("https://host.example/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({ error: "no synthetic route for POST /api/accounts" });
  });

  it("keeps a fixtures key naming no tool unreachable", async () => {
    const response = await syntheticFetch("https://host.example/api/ghosts", { method: "GET" });
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({ error: "no synthetic route for GET /api/ghosts" });
  });

  it("prefers the most specific template: a static segment beats a {param} declared earlier", async () => {
    // {id} declared FIRST — declaration-order matching would shadow /me and
    // show another user's fixture row as "me".
    const overlapping: ExtractedTool[] = [
      {
        name: "host_users_get",
        description: "GET /api/users/{id}",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: true },
        risk: "read",
        binding: { kind: "route", method: "GET", path: "/api/users/{id}", argsIn: "query" },
      },
      {
        name: "host_users_me",
        description: "GET /api/users/me",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        risk: "read",
        binding: { kind: "route", method: "GET", path: "/api/users/me", argsIn: "query" },
      },
    ];
    const overlappingFetch = createSyntheticFetch({
      tools: overlapping,
      fixtures: {
        format: VENDO_FIXTURES_FORMAT,
        fixtures: {
          host_users_get: [{ id: "usr_42", name: "Ada Lovelace" }],
          host_users_me: [{ id: "usr_me", name: "Demo Visitor" }],
        },
      },
    });

    const me = await overlappingFetch("https://host.example/api/users/me", { method: "GET" });
    expect(await body(me)).toEqual([{ id: "usr_me", name: "Demo Visitor" }]);

    // The param tool still serves every non-static id (single-item shape).
    const byId = await overlappingFetch("https://host.example/api/users/42", { method: "GET" });
    expect(await body(byId)).toEqual({ id: "usr_42", name: "Ada Lovelace" });
  });

  it("documented gap: an array-valued {param} spanning multiple segments answers an honest 404", async () => {
    // withPathArgs joins array params into several path segments; the
    // segment-count check then never matches — 404, not a wrong fixture.
    const response = await syntheticFetch("https://host.example/api/invoices/a/b", { method: "GET" });
    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({ error: "no synthetic route for GET /api/invoices/a/b" });
  });

  it("normalizes a lowercase binding method so the route still matches", async () => {
    const lax: ExtractedTool[] = [{
      name: "host_reports_list",
      description: "GET /api/reports",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      risk: "read",
      binding: { kind: "route", method: "get" as never, path: "/api/reports", argsIn: "query" },
    }];
    const laxFetch = createSyntheticFetch({
      tools: lax,
      fixtures: { format: VENDO_FIXTURES_FORMAT, fixtures: { host_reports_list: [{ id: "rep_1" }] } },
    });
    const response = await laxFetch("https://host.example/api/reports", { method: "GET" });
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual([{ id: "rep_1" }]);
  });

  it("decodes encoded {param} segments the way withPathArgs encoded them", async () => {
    const response = await syntheticFetch(`https://host.example/api/invoices/${encodeURIComponent("inv/odd id")}`, {
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ id: "inv_1", total: 120 });
  });
});
