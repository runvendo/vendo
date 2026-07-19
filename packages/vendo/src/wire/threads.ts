import { VendoError } from "@vendoai/core";
import { registerActiveTurn, touchActiveTurn, trackTurnResponse } from "../turn-liveness.js";
import { json, requestJson, route, string, type RouteEntry } from "./shared.js";

/** The effective thread id the agent stamps on every turn response (03 §1). */
const THREAD_ID_HEADER = "x-vendo-thread-id";

/** 09 §3 — the /threads wire area: chat streaming plus thread list/get/delete. */
export const threadRoutes: RouteEntry[] = [
  route("POST", "/threads", async ({ request, deps, context }) => {
    const body = await requestJson(request);
    const ctx = await context("chat");
    void deps.telemetry?.track("agent_run", {});
    // AGENT-3 (fast path): a propagated client disconnect aborts the request,
    // which cancels the agent loop — provider calls stop instead of running to
    // completion for a reader that is gone.
    // ENG-353 (fallback): some runtimes never surface a graceful disconnect
    // (`next dev` fires neither the signal nor a cancel), so a heartbeat-armed
    // idle watchdog can abort the turn through the same controller. Consumers
    // that never beat keep run-to-completion semantics.
    const turnAbort = new AbortController();
    if (request.signal.aborted) turnAbort.abort();
    else request.signal.addEventListener("abort", () => turnAbort.abort(), { once: true });
    const turn = await deps.agent.stream({
      ...(body["threadId"] === undefined ? {} : { threadId: string(body["threadId"], "threadId") }),
      message: body["message"] as never,
      ctx,
      signal: turnAbort.signal,
    });
    const threadId = turn.headers.get(THREAD_ID_HEADER);
    if (threadId === null) return turn;
    const unregister = registerActiveTurn({
      threadId,
      subject: ctx.principal.subject,
      abort: () => turnAbort.abort(),
    });
    return trackTurnResponse(turn, unregister);
  }),
  // ENG-353 — turn-liveness beat. Principal-scoped: it refreshes only the
  // caller's own in-flight turns, and unknown/foreign ids answer
  // `active: false` (no oracle).
  route("POST", "/threads/:id/heartbeat", async ({ context, params }) => {
    const ctx = await context("chat");
    const id = string(params["id"], "thread id");
    return json({ active: touchActiveTurn(id, ctx.principal.subject) });
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
