import { VendoError, withSseKeepalive } from "@vendoai/core";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { registerActiveTurn, touchActiveTurn, trackTurnResponse } from "../turn-liveness.js";
import { recordResumableTurn, resumableTurnStream } from "../turn-resume.js";
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
    // Architecture §3 — one turn, two possible thinkers, ONE request shape. The
    // harness path takes the same `{ threadId?, message, ctx, signal }` and
    // returns the same SSE `Response` with the same thread-id header, so nothing
    // downstream (liveness, abort, the client) can tell which ran.
    //
    // Post-flip (wave 2) EVERY host is routed here — `harness:` when the host
    // named one, `vendo()` when they did not. `deps.harness` is unset for exactly
    // one reason, and it is a capability fact rather than a preference: a store
    // with no SQL handle cannot serve the transcript and workspace TABLES a
    // harness turn needs, so those deployments keep `agent.stream`, which needs
    // neither. See `storeServesHarnessTurns` in server.ts.
    const runTurn = deps.harness ?? deps.agent;
    const turn = await runTurn.stream({
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
    // Stream resume (blueprint §4.1 item 5): the turn's bytes are recorded so a
    // client whose connection died can rejoin through `GET /threads/:id/stream`.
    // Recorded HERE because this is the one place both engines' turns converge
    // and the turn's identity (thread + subject) already exists.
    //
    // Recorder INSIDE, liveness OUTSIDE, and the order is load-bearing: ENG-353's
    // registration must end when THIS CLIENT stops reading, not when the turn's
    // bytes run out. The recorder drains its own branch, so the turn still
    // completes for a reader who left — but the watchdog keeps watching a turn
    // whose client is merely slow.
    return trackTurnResponse(
      recordResumableTurn(turn, { threadId, subject: ctx.principal.subject }),
      unregister,
    );
  }),
  // The SERVER half of `ChatTransport.reconnectToStream` (ai@6): the URL, the
  // method and the 204 are the SDK's, not ours. 204 = nothing in flight, so the
  // client goes back to ready on its persisted transcript.
  route("GET", "/threads/:id/stream", async ({ context, params }) => {
    const ctx = await context("chat");
    const id = string(params["id"], "thread id");
    const replay = resumableTurnStream({ threadId: id, subject: ctx.principal.subject });
    if (replay === null) return new Response(null, { status: 204 });
    const response = withSseKeepalive(new Response(replay, { headers: UI_MESSAGE_STREAM_HEADERS }));
    // The resumed consumer takes over the turn's liveness beat: the panel's
    // `withTurnHeartbeat` arms itself off this header, so a turn whose first
    // client vanished is kept alive by the one that rejoined instead of being
    // idle-aborted out from under it.
    response.headers.set(THREAD_ID_HEADER, id);
    return response;
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
