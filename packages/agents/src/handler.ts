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
 * approvals/grants wire the agent already builds, and then this mount's own
 * table — the chat turn, the thread lifecycle, the durable resume.
 *
 * The table runs on `./http/router.js`, the SAME route runtime the umbrella's
 * wire runs on, so a standalone mount and the embed cannot drift into two
 * routers with two ideas of what `/threads/:id` means.
 *
 * MOUNTING NOTE: the door and the permission wire keep their own absolute paths
 * (`DOOR_PATH`, `PERMISSIONS_PATH`) because the box dials the first and
 * `@vendoai/ui`'s consent surfaces post to the second. A deployment whose engine
 * thinks outside this process therefore routes those paths here too — mounting
 * this handler at `/api/vendo` puts all three under one catch-all.
 */
import { isVendoError, VendoError, type Json, type Principal, type ThreadId } from "@vendoai/core";
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
      // The five permission routes, which answer `undefined` for every path they
      // do not own — which is what lets them sit in front of this table.
      const permissions = await agent.permissions(request);
      if (permissions !== undefined) return permissions;
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
      const forwarded = options.headers === false ? undefined : options.headers ?? request.headers;
      const routed = await dispatchRoutes(ROUTES, {
        request,
        path,
        segments: routeSegments(path),
        params: {},
        agent,
        threads,
        transcript,
        principal: { kind: "user", subject: user.subject },
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
