import { VendoError, type Json } from "@vendoai/core";
import { json, requestJson, route, string, type RouteEntry } from "./shared.js";

/** 06-apps / 09 §3 — the /apps wire area: CRUD, open/call/edit, history,
    ship-diff, pin drift/rebase, export/import, fork. */
export const appRoutes: RouteEntry[] = [
  // Grouped like the old if-chain arm: ANY method on /apps resolves context
  // first; an unhandled method falls through to the table's not-found.
  route("*", "/apps", async ({ request, deps, context }) => {
    const ctx = await context("app");
    if (request.method === "GET") {
      return json(await deps.apps.list(ctx));
    }
    if (request.method === "POST") {
      const body = await requestJson(request);
      return json(await deps.apps.create({ prompt: string(body["prompt"], "prompt") }, ctx));
    }
    return undefined;
  }),
  route("POST", "/apps/import", async ({ request, deps, context }) => {
    // The CSRF floor exempts import (binary body), so it must instead require
    // a non-CORS-safelisted media type — forcing a cross-origin preflight so
    // a simple credentialed form/text POST cannot silently import (09 §3).
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/octet-stream" && contentType !== "application/vnd.vendo.app") {
      throw new VendoError("validation", "import requires Content-Type: application/octet-stream");
    }
    const ctx = await context("app");
    return json(await deps.apps.importApp(new Uint8Array(await request.arrayBuffer()), ctx));
  }),
  // The old `head === "apps" && segments.length >= 2` grouped arm, verbatim:
  // context resolves for ANY /apps/:appId[/...] request before the method and
  // operation checks, and an unmatched combination falls through to not-found.
  route("*", "/apps/:appId/*", async (wire) => {
    const { request, deps, params, segments } = wire;
    const appId = string(params["appId"], "app id");
    const ctx = await wire.context("app");
    const operationName = segments[2];
    if (segments.length === 2) {
      if (request.method === "GET") {
        const app = await deps.apps.get(appId, ctx);
        if (app === null) throw new VendoError("not-found", `app not found: ${appId}`);
        return json(app);
      }
      if (request.method === "DELETE") {
        await deps.apps.delete(appId, ctx);
        return json({});
      }
    }
    const operation = operationName;
    if (request.method === "GET" && operation === "open" && segments.length === 3) {
      return json(await deps.apps.open(appId, ctx));
    }
    if (request.method === "POST" && operation === "call" && segments.length === 3) {
      const body = await requestJson(request);
      return json(await deps.apps.call(appId, string(body["ref"], "ref"), body["args"] as Json, ctx));
    }
    if (request.method === "POST" && operation === "edit" && segments.length === 3) {
      const body = await requestJson(request);
      return json(await deps.apps.edit(appId, string(body["instruction"], "instruction"), ctx));
    }
    if (operation === "history" && segments.length === 3) {
      if (await deps.apps.get(appId, ctx) === null) throw new VendoError("not-found", `app not found: ${appId}`);
      if (request.method === "GET") return json(await deps.apps.history(appId).list());
      if (request.method === "POST") {
        const body = await requestJson(request);
        if (body["op"] !== "undo") throw new VendoError("validation", "history op must be undo");
        return json(await deps.apps.history(appId).undo());
      }
    }
    // 06-apps §8–§9 — additive: the reviewable diff of what this app ships
    // relative to the captured host baselines, hash-pinned to the version
    // an in-client approval would cover. Owner-scoped like every app route.
    if (request.method === "GET" && operation === "ship-diff" && segments.length === 3) {
      return json(await deps.apps.inClient.shipDiff(appId, ctx));
    }
    // 06-apps §8 — additive drift→rebase surface, owner-scoped like every
    // app route. A rebase rewrites content, so it is only ever invoked
    // explicitly here or via the vendo_apps_rebase_pin agent tool — drift
    // detection never auto-rebases.
    if (request.method === "GET" && operation === "pin-drift" && segments.length === 3) {
      return json(await deps.apps.pins.drift(appId, ctx));
    }
    if (request.method === "POST" && operation === "rebase-pin" && segments.length === 3) {
      const body = await requestJson(request);
      return json(await deps.apps.pins.rebase({ appId, slot: string(body["slot"], "slot") }, ctx));
    }
    if (request.method === "GET" && operation === "export" && segments.length === 3) {
      const bytes = await deps.apps.exportApp(appId, ctx);
      return new Response(bytes as BodyInit, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${appId}.vendoapp"`,
        },
      });
    }
    if (request.method === "POST" && operation === "fork" && segments.length === 3) {
      return json(await deps.apps.fork(appId, ctx));
    }
    return undefined;
  }),
];
