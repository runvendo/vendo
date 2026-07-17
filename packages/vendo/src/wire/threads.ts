import { VendoError } from "@vendoai/core";
import { json, requestJson, route, string, type RouteEntry } from "./shared.js";

/** 09 §3 — the /threads wire area: chat streaming plus thread list/get/delete. */
export const threadRoutes: RouteEntry[] = [
  route("POST", "/threads", async ({ request, deps, context }) => {
    const body = await requestJson(request);
    const ctx = await context("chat");
    void deps.telemetry?.track("agent_run", {});
    return await deps.agent.stream({
      ...(body["threadId"] === undefined ? {} : { threadId: string(body["threadId"], "threadId") }),
      message: body["message"] as never,
      ctx,
      // AGENT-3: client disconnect aborts the request, which cancels the
      // agent loop — provider calls stop instead of running to completion
      // for a reader that is gone.
      signal: request.signal,
    });
  }),
  route("GET", "/threads", async ({ deps, context }) => {
    return json(await deps.agent.threads.list(await context("chat")));
  }),
  // Grouped like the old if-chain arm: ANY method resolves context first, and
  // an unhandled method falls through to the table's not-found.
  route("*", "/threads/:id", async ({ request, deps, context, params }) => {
    const ctx = await context("chat");
    const id = string(params["id"], "thread id");
    if (request.method === "GET") {
      const thread = await deps.agent.threads.get(id, ctx);
      if (thread === null) throw new VendoError("not-found", `thread not found: ${id}`);
      return json(thread);
    }
    if (request.method === "DELETE") {
      await deps.agent.threads.delete(id, ctx);
      return json({});
    }
    return undefined;
  }),
];
