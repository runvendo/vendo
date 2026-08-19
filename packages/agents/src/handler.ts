/**
 * ONE mount: the whole agent over HTTP.
 *
 * A library cannot add a route to the host's server, so — like `door` and
 * `permissions` — this comes back as a fetch handler for the host to mount:
 *
 *     const handle = agentHandler(support, { basePath: "/api/agent", resolveUser });
 *     // Next: export { handle as GET, handle as POST, handle as DELETE }
 *     // Hono: app.all("/api/agent/*", (c) => handle(c.req.raw))
 *
 * Three planes come off the one catch-all, in the order a request meets them:
 * the engine's dial-back door (always-on internal plumbing on its own fixed
 * path, answering a live turn's own credential and nothing else), the
 * approvals/grants wire under THIS mount, and then its own table — the chat
 * turn, the thread lifecycle, the durable resume.
 *
 * The permission wire is mounted HERE, on this basePath and behind this mount's
 * `resolveUser`, rather than forwarded to `agent.permissions` on its fixed
 * `/api/vendo`. Two reasons, and the browser found both: deciding an approval
 * is what UNBLOCKS a parked turn (the guard's decision resolves the waiter the
 * turn is sitting on — packages/harnesses/src/turn-tools.ts:122,382), so a
 * client that cannot reach this wire has a park it can never answer; and a
 * standalone host configures identity once, in `resolveUser`, so the asks a
 * person sees must be scoped to the same person the turns are.
 *
 * The table runs on `./http/router.js`, the SAME route runtime the umbrella's
 * wire runs on, so a standalone mount and the embed cannot drift into two
 * routers with two ideas of what `/threads/:id` means.
 *
 * MOUNTING NOTE: the door keeps its own absolute path (`DOOR_PATH`) because that
 * is the address the box dials. A deployment whose engine thinks outside this
 * process therefore routes that path here too — mounting this handler at
 * `/api/vendo` puts it and everything else under one catch-all.
 */
import { isVendoError, VendoError, type Json, type Principal, type ThreadId } from "@vendoai/core";
import { handlePermissionRequest } from "@vendoai/guard";
import { threadMessageStore, threadStore } from "@vendoai/store";
import type { UIMessage } from "ai";
import { agentComposition, type VendoAgent } from "./agent.js";
import { DOOR_PATH } from "./door.js";
import {
  dispatchRoutes,
  errorResponse,
  json,
  relativePath,
  requestJson,
  route,
  routeSegments,
  string,
  type RouteContext,
  type RouteEntry,
} from "./http/router.js";
import type { RespondOptions } from "./session.js";

/** Who the host says is asking. */
export interface HandlerUser {
  /** The subject every thread, grant and audit row on this request is scoped to. */
  subject: string;
  /** Server-trust identity facts, model-visible (`[User]`). */
  profile?: Record<string, Json>;
  /** Guard/tools context: functions run at check-time, data survives parking. */
  context?: Record<string, unknown>;
}

/**
 * Two options the v1 spec names are deliberately ABSENT rather than forgotten.
 *
 * `publicOrigin` could not take effect: the door's origin is fixed when
 * `agent()` composes, and `resolveDoor` already throws the boot error naming
 * both ways out for a sandboxed engine with no origin (door.ts:96-107) — long
 * before a mount exists. `mcp` governs a PUBLIC MCP/auth plane, which this
 * package does not serve; the spec defaults it OFF, so omitting it and
 * defaulting it off are the same behaviour. Both are additive the day either
 * has something to do.
 */
export interface HandlerOptions {
  /** Where the host mounted this handler. */
  basePath: string;
  /** The host's own session, read per request. `null` is UNAUTHENTICATED and
   *  answers 401 — a mount with nobody asking serves nobody's conversation. */
  resolveUser: (request: Request) => Promise<HandlerUser | null>;
  /** What the turn's own tools forward as the caller's authority. Unset → this
   *  request's own headers, which is what a same-origin host wants; `false` →
   *  nothing. Per request either way: request-lifetime authority does not
   *  outlive the request. */
  headers?: Record<string, string> | false;
}

/** The per-request view this mount's handlers read, on top of what the shared
 *  matcher needs. */
interface AgentWire extends RouteContext {
  agent: VendoAgent;
  threads: ReturnType<typeof threadStore>;
  transcript: ReturnType<typeof threadMessageStore<UIMessage>>;
  principal: Principal;
  subject: string;
  /** The identity every turn on THIS request runs with. */
  turn: RespondOptions;
}

const ROUTES: readonly RouteEntry<AgentWire>[] = [
  // One turn, as an AI-SDK UI-message stream — the same Response `respond()`
  // hands back, with the conversation's id on `x-vendo-thread-id`. The request's
  // own signal rides along, so a client that leaves cancels the turn instead of
  // paying a provider to answer nobody.
  route("POST", "/threads", async ({ request, agent, subject, turn }) => {
    const body = await requestJson(request);
    return agent.respond(subject, body["message"] as UIMessage, {
      ...turn,
      ...(body["threadId"] === undefined ? {} : { threadId: string(body["threadId"], "threadId") }),
      signal: request.signal,
    });
  }),
  route("GET", "/threads", async ({ threads, principal }) => json(await threads.list(principal))),
  // Grouped like the umbrella's arm: an unhandled method falls through to the
  // table's not-found rather than being answered here.
  route("*", "/threads/:id", async ({ request, threads, transcript, principal, params }) => {
    const id = string(params["id"], "thread id") as ThreadId;
    if (request.method === "GET") {
      // The thread row is the ownership record and every read joins it under
      // this subject, so a foreign id reads back as absent — the same answer as
      // one that never existed.
      if (await threads.get(principal, id) === null) {
        throw new VendoError("not-found", `thread not found: ${id}`);
      }
      return json({ id, messages: await transcript.list(principal, id) });
    }
    if (request.method === "DELETE") {
      await threads.delete(principal, id);
      return json({});
    }
    return undefined;
  }),
  // SEAM — durable resume is `turns.resume`, and its rules (partial decision
  // maps, `conflict` on a turn that is not interrupted, the turnId that stays
  // stable across park and resume) are frozen in the slice that owns it. The
  // route is wired so this mount's shape is final; a second set of those rules
  // invented here is exactly how one rule becomes two. Until that verb lands,
  // an approval is answered in the stream it was asked in.
  route("POST", "/turns/:turnId/resume", async () => {
    throw new VendoError(
      "not-implemented",
      "Durable resume is not wired in this build. Answer the approval on the turn's own stream.",
    );
  }),
];

export function agentHandler(
  agent: VendoAgent,
  options: HandlerOptions,
): (request: Request) => Promise<Response> {
  const composition = agentComposition(agent);
  if (composition === undefined) {
    throw new VendoError("validation", "agentHandler(agent) needs an agent built by agent().");
  }
  // A host may spell the mount with a trailing slash; strip it once here rather
  // than doubling it into every boundary below.
  const mount = options.basePath.replace(/\/$/, "");
  const threads = threadStore(composition.store);
  const transcript = threadMessageStore<UIMessage>(composition.store);

  return async (request) => {
    try {
      const url = new URL(request.url);
      // The door FIRST, on its own absolute path: it is internal plumbing that
      // authenticates every request with the live turn's own credential, so it
      // owes this mount's `resolveUser` nothing and must not be challenged by it.
      if (agent.door !== undefined && url.pathname === DOOR_PATH) return await agent.door(request);
      const path = relativePath(mount, url);
      if (path === null) throw new VendoError("not-found", "unknown route");
      const user = await options.resolveUser(request);
      // 401, not 403: `resolveUser` answering null means nobody is asking. The
      // umbrella's wire answers 403 to an unresolved principal
      // (packages/vendo/src/wire/context.ts) because there it is the HOST's
      // session that already ran and declined; here this is the first identity
      // check the request meets, and an unauthenticated caller is told to
      // authenticate.
      if (user === null) return new Response(null, { status: 401 });
      // The same gate `createSession` and the permission mount pay: this is a
      // fresh entry door, and a virgin store must not answer the first request
      // with a missing relation.
      await composition.store.ensureSchema();
      const principal: Principal = { kind: "user", subject: user.subject };
      // The five permission routes, ahead of the table and sharing the identity
      // already resolved above. The area check is what keeps the body unread for
      // everything else — `POST /threads` needs its own.
      if (["approvals", "grants"].includes(path.split("/").filter(Boolean)[0] ?? "")) {
        const answered = await handlePermissionRequest(composition.guard, principal, {
          method: request.method as "GET" | "POST" | "DELETE",
          path,
          ...(request.method === "POST" ? { body: await request.json().catch(() => undefined) } : {}),
        });
        if (answered !== undefined) return json(answered.body);
      }
      const forwarded = options.headers === false ? undefined : options.headers ?? request.headers;
      const routed = await dispatchRoutes(ROUTES, {
        request,
        path,
        segments: routeSegments(path),
        params: {},
        agent,
        threads,
        transcript,
        principal,
        subject: user.subject,
        turn: {
          ...(user.profile === undefined ? {} : { user: user.profile }),
          ...(user.context === undefined ? {} : { context: user.context }),
          ...(forwarded === undefined ? {} : { headers: forwarded }),
        },
      });
      if (routed !== undefined) return routed;
      throw new VendoError("not-found", "unknown route");
    } catch (error) {
      // A refusal this mount can name answers in the wire's envelope; anything
      // else is the host's own failure and PROPAGATES, so their logging sees it
      // rather than a swallowed 500 that says nothing.
      if (isVendoError(error)) return errorResponse(error);
      throw error;
    }
  };
}
