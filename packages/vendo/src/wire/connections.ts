import { VendoError } from "@vendoai/core";
import { json, requestJson, route, string, type RouteEntry } from "./shared.js";

/** 04-actions §3 (block-actions design §B) — per-principal connected
    accounts. Subject scoping happens HERE: the wire passes exactly the
    resolved principal; no caller-supplied subject exists on this surface. */
export const connectionRoutes: RouteEntry[] = [
  route("GET", "/connections", async ({ deps, context }) => {
    const ctx = await context("chat");
    return json({ connections: await deps.connections.list(ctx.principal) });
  }),
  route("POST", "/connections/initiate", async ({ request, deps, context }) => {
    const body = await requestJson(request);
    const ctx = await context("chat");
    return json(await deps.connections.initiate(ctx.principal, {
      toolkit: string(body["toolkit"], "toolkit"),
      ...(body["connector"] === undefined ? {} : { connector: string(body["connector"], "connector") }),
      ...(body["callbackUrl"] === undefined ? {} : { callbackUrl: string(body["callbackUrl"], "callbackUrl") }),
    }));
  }),
  // The connect dock's auto catalog. Host-level rows, but the principal still
  // resolves first so this surface authenticates exactly like its siblings.
  // Must precede /connections/:id, which would otherwise swallow "catalog".
  route("GET", "/connections/catalog", async ({ deps, context }) => {
    await context("chat");
    return json({ available: await deps.connections.catalog() });
  }),
  // Grouped like the old if-chain arm: ANY method resolves context first, and
  // an unhandled method falls through to the table's not-found.
  route("*", "/connections/:id", async ({ request, url, deps, context, params }) => {
    const connectionId = string(params["id"], "connection id");
    const connector = url.searchParams.get("connector") ?? "composio";
    const ctx = await context("chat");
    if (request.method === "GET") {
      const connection = await deps.connections.status(ctx.principal, connector, connectionId);
      if (connection === null) throw new VendoError("not-found", `connection not found: ${connectionId}`);
      return json(connection);
    }
    if (request.method === "DELETE") {
      await deps.connections.disconnect(ctx.principal, connector, connectionId);
      return json({});
    }
    return undefined;
  }),
];
