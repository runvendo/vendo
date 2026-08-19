import { defineOwn, isPlainObject, mintTurnId, THREAD_WINDOW_INITIAL, VendoError, vendoViewWirePartSchema, withSseKeepalive } from "@vendoai/core";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { registerActiveTurn, steerActiveTurn, touchActiveTurn, trackTurnResponse } from "../turn-liveness.js";
import { recordResumableTurn, resumableTurnStream } from "../turn-resume.js";
import { json, requestJson, route, string, type RouteEntry } from "./shared.js";

/** The effective thread id the agent stamps on every turn response (03 §1). */
const THREAD_ID_HEADER = "x-vendo-thread-id";

/**
 * Arrival — the apps a transcript RENDERS.
 *
 * The thread card draws each `data-vendo-view` part straight from the part
 * (`chrome/thread/parts.tsx`), with no `open()` of its own, so nothing in a
 * thread render reaches the route that marks an app seen. Reading the thread back
 * IS that render, and it is the one server event a thread render has.
 *
 * Parsed with the part's own validator rather than by reaching into its shape:
 * `vendoViewPart` is the single producer and this is the matching consumer, so a
 * part the producer would not emit is not counted as a render here either.
 */
const renderedApps = (messages: readonly unknown[]): string[] => {
  const ids = new Set<string>();
  for (const message of messages) {
    const parts = isPlainObject(message) ? message["parts"] : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const view = vendoViewWirePartSchema.safeParse(part);
      if (view.success) ids.add(view.data.data.appId);
    }
  }
  return [...ids];
};

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
    // Minted HERE, and handed to the door on the ctx: the runtime adopts a
    // caller's `turnId` (that is how `agent.chat().turnId` stays joinable to the
    // rows its turn writes), so the registration below and the finish signal
    // that ends its watchdog name the SAME turn. Nothing serializes two turns on
    // one thread, so naming only the thread would let either one stand the
    // other's watchdog down.
    const turnId = mintTurnId();
    // Architecture §3 — ONE thinker's door. `harness:` when the host named one,
    // `vendo()` when they did not; a store that can keep neither the transcript
    // nor the workspace refuses the turn inside the door, naming what it needs.
    const turn = await deps.harness.stream({
      ...(body["threadId"] === undefined ? {} : { threadId: string(body["threadId"], "threadId") }),
      message: body["message"] as never,
      ctx: { ...ctx, turnId, ...(situation === undefined ? {} : { context: situation }) },
      signal: turnAbort.signal,
    });
    const threadId = turn.headers.get(THREAD_ID_HEADER);
    if (threadId === null) return turn;
    // The watchdog's abort gets its own channel beside the fast path's: an idle
    // abort is the SERVER ending the turn, so this client is told on its stream
    // instead of being left on bytes that stop, while a client that aborted its
    // own fetch is told nothing (it is gone).
    const idleAbort = new AbortController();
    const unregister = registerActiveTurn({
      threadId,
      subject: ctx.principal.subject,
      turnId,
      abort: () => {
        idleAbort.abort();
        turnAbort.abort();
      },
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
      idleAbort.signal,
    );
  }),
  // Prompt-cache warming (sub-1s shipment): the client fires this once when
  // the chat surface opens, so the user's FIRST message reads a warm provider
  // prefix instead of writing a cold one. Best-effort on both sides: the 204
  // carries nothing, a failure costs nothing but the warmth, and an engine
  // without a warm door (the createAgent path) simply answers 204 unwarmed.
  route("POST", "/threads/warm", async ({ deps, context }) => {
    const ctx = await context("chat");
    const door = deps.harness as { warm?: (input: { ctx: unknown }) => Promise<void> };
    if (typeof door.warm === "function") await door.warm({ ctx });
    return new Response(null, { status: 204 });
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
  // D4 — the thread lifecycle is the HARNESS door's, on every deployment. It
  // rides the adapter-only ThreadRepository, so unlike `stream` it needs no SQL
  // handle and a hosted store is served here too.
  route("GET", "/threads", async ({ deps, context }) => {
    return json(await deps.harness.threads.list(await context("chat")));
  }),
  // Grouped like the old if-chain arm: ANY method resolves context first, and
  // an unhandled method falls through to the table's not-found.
  route("*", "/threads/:id", async ({ request, deps, context, params }) => {
    const ctx = await context("chat");
    const id = string(params["id"], "thread id");
    if (request.method === "GET") {
      const thread = await deps.harness.threads.get(id, ctx);
      if (thread === null) throw new VendoError("not-found", `thread not found: ${id}`);
      // Arrival — opening the conversation renders the apps its view parts name,
      // so this is where that render is recorded. Person-only by construction,
      // which is what keeps the property the mark was moved off `open` for: this
      // route mints `kind:"user"` / `presence:"present"` (wire/context.ts) and the
      // repository answers only the caller's own threads, so an agent, an
      // automation, an export or an MCP tool cannot reach it — an away run can
      // WRITE a view part into a sponsor's thread, and still only the sponsor
      // reading it back marks it seen.
      //
      // Settled, never awaited outright: arrival is bookkeeping and may not change
      // the answer. A transcript outlives the app it drew, so a view part for a
      // deleted app would otherwise turn the whole conversation into a 404 —
      // `seen` re-checks access and throws not-found. A dropped mark costs a dot
      // that clears one render later.
      // Only the TRAILING WINDOW, because that is all the client mounts: a long
      // thread defers its head behind "Show N earlier messages"
      // (`chrome/thread/scrolling.ts`), and a deferred message is absent from the
      // DOM, so the app card inside it was never drawn. Marking the whole stored
      // transcript cleared the dot for apps the person never saw — and the record
      // is first-seen (`app-seen.ts`), so nothing could take it back.
      //
      // The asymmetry is deliberate. An app buried behind the deferred head does
      // NOT clear on thread open; it still clears the moment the person opens the
      // app itself (`wire/apps.ts`). A dot that lingers one render too long is a
      // small annoyance; a dot that clears for something never seen is the exact
      // failure this whole mechanism exists to prevent, so under-clearing is the
      // direction to err in. Acknowledging a window as it renders would need a new
      // client→server signal, which the note at the top of this file says the
      // architecture deliberately does without.
      if (deps.mounted.apps) {
        const rendered = renderedApps(thread.messages.slice(-THREAD_WINDOW_INITIAL));
        await Promise.allSettled(rendered.map((appId) => deps.apps.seen(appId, ctx)));
      }
      return json(thread);
    }
    if (request.method === "DELETE") {
      await deps.harness.threads.delete(id, ctx);
      return json({});
    }
    return undefined;
  }),
];
