/**
 * ADAPTER RULE, door seam — the origin a thinker that is NOT in this process
 * dials back to, and the door it finds when it gets there.
 *
 * A harness whose thinker runs on a machine cannot hold the guard-bound
 * registry: the registry is the host's, and the box is deliberately
 * credential-free. It reaches the SAME `turn.tools` over the host's own MCP
 * door (10-mcp §3b), which means the box has to be able to DIAL the host. A web
 * server knows its own origin; a LIBRARY has no address, so the host names one.
 *
 * Precedence, top to bottom:
 *   1. an explicit `door: { baseUrl }` always wins (the hard BYO rule);
 *   2. VENDO_BASE_URL — the same operator variable the umbrella defaults its own
 *      door origin from, so one deployment fact serves both shapes. Trimmed,
 *      because a whitespace-only value is not an origin;
 *   3. for a thinker on THIS machine (`machine: "local"`) only: a loopback
 *      listener this package serves itself, because a subprocess can always
 *      dial 127.0.0.1 — the same zero-config development shape the umbrella
 *      gets by learning its loopback origin from the wire. Never for a box:
 *      loopback is not reachable from a sandbox;
 *   4. nothing, and for a harness that needs a SANDBOX that is a BOOT error
 *      naming both ways out. Falling through is what this file exists to end:
 *      the box keeps its own hands (Bash, Read, Write) and loses every HOST
 *      tool, so the model answers politely and does nothing — the
 *      polite-refusal-at-HTTP-200 failure this codebase refuses to ship.
 *      It was silent for a whole release.
 *
 * The door itself is `createMcpDoor({ internal: true })`, the same internal half
 * the umbrella mounts: no authorization server, no discovery documents, no
 * consent page, no client registration, and no listing for anyone but a live
 * turn. A library cannot inject a route into the host's server, so its handler
 * comes back out of `agent()` for the host to mount at {@link DOOR_PATH}.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { VendoError, type Guard, type StoreAdapter, type ToolRegistry } from "@vendoai/core";
import type { ToolDoorPort } from "@vendoai/harnesses";
import { createMcpDoor, createTurnCredentials, type LiveTurn } from "@vendoai/mcp";

/** Where the host mounts {@link AgentDoor.handler}, and the path the box dials.
 *  The umbrella's mount, deliberately: a deployment that later wraps this agent
 *  in `createVendo` does not have to move its box's dial-back path. */
export const DOOR_PATH = "/api/vendo/mcp";

export interface DoorConfig {
  /** The PUBLIC origin a sandbox box can reach — `https://app.example.com`.
   *  Only the origin is used; behind a reverse proxy this is the outside
   *  address, never the proxy-internal one the request arrives on. */
  baseUrl: string;
}

export interface AgentDoor {
  /** Fetch-style, for the host to mount at {@link DOOR_PATH}. */
  handler(request: Request): Promise<Response>;
  /** What the harness reads at turn time: where to dial, and one credential per
   *  conversation. */
  port: ToolDoorPort;
  /** The runtime's `liveTurn` seam. Publishing is not a grant — it is the only
   *  thing that makes an already-minted credential resolve, and its authority
   *  window is exactly the turn. */
  publish(threadId: string, turn: LiveTurn): () => void;
  /** Loopback rung only: resolves once the listener is bound, so `session()`
   *  can guarantee `port.url` is never read mid-bind. A named origin needs no
   *  waiting and carries none. */
  ready?: Promise<void>;
}

const environment = (name: string): string | undefined => {
  if (typeof process === "undefined") return undefined;
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

/** Everything the internal door serves a live turn from. All of it already
 *  exists at `agent()` time — the door composes from parts, it never builds
 *  a second registry or a second guard. */
export interface DoorParts {
  /** Guard-bound already — the one choke point, shared with `session.stream`. */
  tools: ToolRegistry;
  guard: Guard;
  store: StoreAdapter;
}

/**
 * The ladder, and what an EMPTY ladder means here — the same division
 * `resolveSandbox` keeps with `selectSandbox`.
 */
export function resolveDoor(
  configured: DoorConfig | undefined,
  harness: { name: string; sandboxed: boolean },
  parts: DoorParts,
): AgentDoor {
  const explicit = configured?.baseUrl.trim();
  const baseUrl = explicit === undefined || explicit === "" ? environment("VENDO_BASE_URL") : explicit;
  if (baseUrl === undefined) {
    if (harness.sandboxed) {
      throw new VendoError(
        "validation",
        `${harness.name} thinks on a sandbox box and reaches your tools over an MCP door, so it needs `
        + "an origin that box can dial: set `door: { baseUrl: \"https://app.example.com\" }` or "
        + `VENDO_BASE_URL, then mount the agent's \`door\` handler at ${DOOR_PATH}. Without one the model `
        + "boots with its own workspace and NONE of your product's actions.",
      );
    }
    return loopbackDoor(parts);
  }

  const credentials = createTurnCredentials();
  return {
    handler: createMcpDoor({
      internal: true,
      tools: parts.tools,
      guard: parts.guard,
      store: parts.store,
      turnCredentials: credentials,
      mount: DOOR_PATH,
      baseUrl,
    }).handler,
    port: {
      url: new URL(DOOR_PATH, baseUrl).toString(),
      mint: credentials.mint,
      revoke: credentials.revoke,
    },
    publish: credentials.publish,
  };
}

/**
 * The loopback rung. A `machine: "local"` thinker is a subprocess on this very
 * machine, so when the deployment names no origin the door serves ITSELF on an
 * ephemeral 127.0.0.1 port — nothing to configure and nothing to mount. Bound
 * to loopback, so only this machine can reach it, and every request still needs
 * a live turn's credential. `unref()`ed: a listener the host never asked for
 * must never be what keeps their process alive.
 */
function loopbackDoor(parts: DoorParts): AgentDoor {
  const credentials = createTurnCredentials();
  const handler = createMcpDoor({
    internal: true,
    tools: parts.tools,
    guard: parts.guard,
    store: parts.store,
    turnCredentials: credentials,
    mount: DOOR_PATH,
  }).handler;

  const server = createServer((incoming, outgoing) => void relay(handler, incoming, outgoing));
  server.unref();
  let origin: string | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });

  return {
    handler,
    port: {
      // Read at TURN time, after `session()` awaited `ready` — undefined only
      // for a caller that skipped the front door entirely.
      get url(): string | undefined {
        return origin === undefined ? undefined : new URL(DOOR_PATH, origin).toString();
      },
      mint: credentials.mint,
      revoke: credentials.revoke,
    },
    publish: credentials.publish,
    ready,
  };
}

/** One Node request through the fetch-style handler. The response body is
 *  PIPED, never buffered — the door's standalone SSE stream stays open. */
async function relay(
  handler: (request: Request) => Promise<Response>,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      for (const one of typeof value === "string" ? [value] : value ?? []) headers.append(name, one);
    }
    const response = await handler(new Request(new URL(incoming.url ?? "/", "http://127.0.0.1"), {
      method: incoming.method,
      headers,
      ...(body.length === 0 ? {} : { body }),
    }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) outgoing.end();
    else Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(outgoing);
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
}
