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
 *   3. nothing, and for a harness that declares `requires.toolDoor` that is a
 *      BOOT error naming both ways out. Falling through is what this file
 *      exists to end: the box keeps its own hands (Bash, Read, Write) and
 *      loses every HOST tool, so the model answers politely and does nothing —
 *      the polite-refusal-at-HTTP-200 failure this codebase refuses to ship.
 *      It was silent for a whole release.
 *
 * The door itself is `createMcpDoor({ internal: true })`, the same internal half
 * the umbrella mounts: no authorization server, no discovery documents, no
 * consent page, no client registration, and no listing for anyone but a live
 * turn. A library cannot inject a route into the host's server, so its handler
 * comes back out of `agent()` for the host to mount at {@link DOOR_PATH}.
 */
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
  harnessName: string,
  parts: DoorParts,
): AgentDoor {
  const baseUrl = configured?.baseUrl.trim() ?? environment("VENDO_BASE_URL");
  if (baseUrl === undefined || baseUrl === "") {
    throw new VendoError(
      "validation",
      `${harnessName} thinks outside this process and reaches your tools over an MCP door, so it needs `
      + "an origin that thinker can dial: pass `door: { baseUrl: \"https://app.example.com\" }` or set "
      + `VENDO_BASE_URL, then mount the agent's \`door\` handler at ${DOOR_PATH}. Without one the model `
      + "boots with its own workspace and NONE of your product's actions.",
    );
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
