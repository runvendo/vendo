import { defineOwn, isPlainObject, VendoError, withSseKeepalive } from "@vendoai/core";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { registerActiveTurn, steerActiveTurn, touchActiveTurn, trackTurnResponse } from "../turn-liveness.js";
import { recordResumableTurn, resumableTurnStream } from "../turn-resume.js";
import { json, requestJson, route, string, type RouteEntry } from "./shared.js";

/** The effective thread id the agent stamps on every turn response (03 §1). */
const THREAD_ID_HEADER = "x-vendo-thread-id";

/** Decision 3 (spec 2026-08-05): the situation channel is capped at 8 KB on
    BOTH ends. The client truncates before sending; this is the server's own
    enforcement on whatever actually arrives. The channel is best-effort
    observation, never a validation surface — anything that is not an object,
    and anything past the budget, is dropped rather than refused. */
const SITUATION_CAP_BYTES = 8192;

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).byteLength;

/** What this entry costs the budget, or `undefined` when it cannot be rendered
 *  at all — a client can nest an array past `JSON.stringify`'s stack, and this
 *  channel drops what it cannot use rather than failing the turn over it. The
 *  prompt assembler stringifies the same value, so an entry that throws here
 *  must not be carried forward. */
function rendered(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  try {
    return JSON.stringify(entry) ?? "";
  } catch {
    return undefined;
  }
}

/** At most `budget` UTF-8 bytes, cut on a CODE POINT boundary: a cut through an
 *  astral character leaves a lone surrogate no provider's JSON body can carry. */
function sliceToBytes(text: string, budget: number): string {
  let spent = 0;
  let end = 0;
  for (const char of text) {
    const size = bytesOf(char);
    if (spent + size > budget) break;
    spent += size;
    end += char.length;
  }
  return text.slice(0, end);
}

function cappedSituation(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const capped: Record<string, unknown> = {};
  let budget = SITUATION_CAP_BYTES;
  for (const [key, entry] of Object.entries(value)) {
    const text = rendered(entry);
    if (text === undefined) continue;
    const cost = bytesOf(key) + bytesOf(text);
    // defineOwn: a client key named __proto__ must become data, never the
    // prototype of the bag the host's own guards and tools read.
    if (cost <= budget) {
      defineOwn(capped, key, entry);
      budget -= cost;
      continue;
    }
    if (typeof entry === "string" && budget > bytesOf(key)) {
      defineOwn(capped, key, sliceToBytes(entry, budget - bytesOf(key)));
    }
    break;
  }
  return Object.keys(capped).length > 0 ? capped : undefined;
}

/** 09 §3 — the /threads wire area: chat streaming plus thread list/get/delete. */
export const threadRoutes: RouteEntry[] = [
  route("POST", "/threads", async ({ request, deps, context }) => {
    const body = await requestJson(request);
    const ctx = await context("chat");
    // Spec 2026-08-05 §2 — the client's situation rides the message POST and
    // lives exactly one turn: onto THIS request's ctx (prompt assembly reads
    // ctx.context), never onto anything the store writes.
    const situation = cappedSituation(body["context"]);
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
      ctx: situation === undefined ? ctx : { ...ctx, context: situation },
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
  // §10.2 — mid-build steering. Modelled on the beat above and scoped the same
  // way: it can only reach the caller's OWN turn in flight, and an unknown or
  // foreign id answers `landed: false`, which is also what an idle thread
  // answers (no oracle). The answer is the ONLY signal the client needs — there
  // is no capability to ask about and nothing to validate up front.
  //
  // Independent of stream-resume above: a steer INJECTS input into the running
  // turn via the registry, while resume REPLAYS the recorded byte stream — so a
  // client that rejoins through `GET /threads/:id/stream` sees the steered
  // output for free, because it flows through the same recorded Response.
  route("POST", "/threads/:id/steer", async ({ request, context, params }) => {
    const ctx = await context("chat");
    const id = string(params["id"], "thread id");
    const body = await requestJson(request);
    return json({
      landed: await steerActiveTurn(
        id,
        ctx.principal.subject,
        string(body["text"], "text"),
        string(body["messageId"], "messageId"),
      ),
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
