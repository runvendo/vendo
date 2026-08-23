/**
 * `vendo.agentTools` — this deployment's door, already wired, for an agent loop
 * the host writes by hand.
 *
 * A host on the AI SDK or Mastra gets `vendoTools(vendo)` and is done. A host
 * driving `@anthropic-ai/sdk` directly had to write the plumbing itself: mint a
 * badge, stand up an MCP client and transport, map the tool format, keep ONE
 * session for the whole conversation (the door pins a parked approval to the
 * session that parked it, so a per-request reconnect parks forever), re-mint
 * when the ten minutes run out, and collect the typed envelopes the page
 * renders. None of that is a decision the host wants to make. It is this file.
 *
 * IN-PROCESS, like `vendo.tokenFor`: every request rides `vendo.handler`, so a
 * deployment never has to be able to reach itself over the network. The client
 * is ours rather than the stock MCP SDK for exactly that reason — the SDK's
 * streamable-HTTP transport is built around a URL it fetches and a background
 * SSE stream someone has to close, and it is a devDependency here, not a
 * dependency. What the door speaks is JSON-RPC over one POST; that is the whole
 * client, below.
 */
import {
  parseVendoToolEnvelope,
  VendoError,
  type Json,
  type VendoToolEnvelope,
} from "@vendoai/core";
import type { VendoComposition } from "./compose-context.js";
import { MCP_MOUNT } from "./door-paths.js";
import { doorOrigin } from "./mcp-token.js";

const DOCS = "https://docs.vendo.run/outside-agents/your-own-agent";
const PROTOCOL_VERSION = "2025-11-25";

/** One tool, in the shape `messages.create({ tools })` takes. Structural on
 *  purpose: this package does not depend on `@anthropic-ai/sdk`, and a host
 *  should not have to annotate anything to pass the list straight through. */
export interface VendoAgentTool {
  name: string;
  description: string;
  input_schema: { type: "object"; [key: string]: unknown };
}

/** The assistant message you got back, as much of it as this needs: the content
 *  blocks. `Anthropic.Message` satisfies it. */
export interface VendoAgentMessage {
  content: readonly { readonly type: string }[];
}

/** One `tool_result` block, ready to push as the next user message's content. */
export interface VendoAgentToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: { type: "text"; text: string }[];
  is_error: boolean;
}

/** One conversation's connection to the door. Hold it for the whole
 *  conversation: the session it opens is what a parked approval resumes on. */
export interface VendoAgentTools {
  /** What this user may call, as the model wants to read it. A snapshot taken
   *  when the door opened — the conversation's tool list is the one its history
   *  refers to.
   *
   *  A mutable array, not a `readonly` one, so it goes STRAIGHT into
   *  `messages.create({ tools })`: the Messages API asks for `Tool[]`, and a
   *  `readonly Tool[]` does not satisfy it, so the reader-friendly modifier
   *  would cost every caller a `[...door.tools]` at the one call site this
   *  whole method exists to shorten. */
  readonly tools: VendoAgentTool[];
  /**
   * Run every `tool_use` block in an assistant message through the door and
   * answer the `tool_result` blocks that go back.
   *
   * `[]` when the model called nothing, which is how the loop knows it is done:
   *
   * ```ts
   * const results = await door.results(reply);
   * if (results.length === 0) break;
   * messages.push({ role: "user", content: results });
   * ```
   *
   * These EXECUTE. Calling it twice on the same message runs the same tools
   * twice — the loop calls it once per assistant turn.
   */
  results(message: VendoAgentMessage): Promise<VendoAgentToolResult[]>;
  /** Every typed envelope this conversation's calls produced, in order — the
   *  approval refs and app refs the host's page renders with `<VendoToolResult>`.
   *  It grows as `results` runs; a plain tool output is not one of these. */
  readonly embeds: readonly VendoToolEnvelope[];
}

const isToolUse = (
  block: { readonly type: string },
): block is { type: "tool_use"; id: string; name: string; input?: unknown } =>
  block.type === "tool_use";

const textBlocks = (content: unknown): { type: "text"; text: string }[] =>
  (Array.isArray(content) ? content : [])
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string")
    .map((part) => ({ type: "text" as const, text: part.text }));

export function composeAgentTools(
  composition: VendoComposition,
  handler: (request: Request) => Promise<Response>,
  tokenFor: (who: Request | string) => Promise<string>,
): (who: Request | string) => Promise<VendoAgentTools> {
  return async (who) => {
    // Asked FIRST, because "no door" is the likelier mistake and the URL
    // refusal below would answer it with the wrong fix.
    if (composition.mcpOptions === undefined) {
      throw new VendoError(
        "not-implemented",
        "vendo.agentTools serves THIS deployment's MCP door, and no door is open: compose "
        + `createVendo({ mcp: true }). ${DOCS}`,
      );
    }
    const origin = doorOrigin(composition, who);
    if (origin === undefined) {
      throw new VendoError(
        "validation",
        "vendo.agentTools needs this deployment's public URL to reach its own MCP door, and none is "
        + "configured: set VENDO_BASE_URL (or createVendo({ mcp: { baseUrl } })), or pass the incoming "
        + `Request — vendo.agentTools(request) — which carries the origin with it. ${DOCS}`,
      );
    }
    // The umbrella dispatches the door at its ORIGIN-ROOT mount, exactly as
    // `tokenFor` does: a path-prefixed deployment strips its own prefix before
    // `vendo.handler` sees a request, and the door re-adds it when it derives
    // the resource URI. Sending the public spelling would 404 short of the door.
    const endpoint = `${origin}${MCP_MOUNT}`;

    let token = "";
    let sessionId: string | undefined;
    let id = 0;

    const send = async (body: Record<string, unknown>): Promise<Response> =>
      handler(new Request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": PROTOCOL_VERSION,
          ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      }));

    const call = async (method: string, params?: unknown): Promise<Response> => {
      id += 1;
      return send({ id, method, ...(params === undefined ? {} : { params }) });
    };

    /** A fresh badge and a fresh session. Runs at open, and again the one time
     *  a request comes back unauthenticated or session-less. */
    const connect = async (): Promise<void> => {
      token = await tokenFor(who);
      sessionId = undefined;
      const opened = await call("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "vendo-agent-tools", version: "1.0.0" },
      });
      if (!opened.ok) {
        throw new VendoError(
          "unavailable",
          `vendo.agentTools could not open a session at ${endpoint}: the door answered ${opened.status} `
          + `${(await opened.text()).slice(0, 200)}. ${DOCS}`,
        );
      }
      sessionId = opened.headers.get("mcp-session-id") ?? undefined;
      await send({ method: "notifications/initialized" });
    };

    /**
     * One round trip, with exactly ONE transparent reconnect.
     *
     * A badge lasts ten minutes and has no refresh, and a session the door has
     * forgotten answers `404 Session not found` — two ways a long conversation
     * dies mid-loop that the host should never have to write code for. Once,
     * because a second failure is a real one, not a stale credential.
     */
    const rpc = async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
      let response = await call(method, params);
      if (response.status === 401 || response.status === 404) {
        await connect();
        response = await call(method, params);
      }
      if (!response.ok) {
        throw new VendoError(
          "unavailable",
          `vendo.agentTools got ${response.status} from this deployment's MCP door on ${method}: `
          + `${(await response.text()).slice(0, 200)}. ${DOCS}`,
        );
      }
      // The door answers JSON-RPC as one JSON body or as SSE frames; the last
      // data line is the result either way.
      const body = await response.text();
      const line = body.split("\n").filter((raw) => raw.startsWith("data:")).at(-1);
      const payload = JSON.parse(line === undefined ? body : line.slice(5).trim()) as {
        result?: Record<string, unknown>;
        error?: { message?: string };
      };
      if (payload.error !== undefined) {
        throw new VendoError(
          "unavailable",
          `vendo.agentTools: this deployment's MCP door refused ${method} — ${payload.error.message}. ${DOCS}`,
        );
      }
      return payload.result ?? {};
    };

    await connect();
    const listed = await rpc("tools/list");
    const tools: VendoAgentTool[] = ((listed["tools"] as Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }> | undefined) ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: (tool.inputSchema ?? { type: "object", properties: {} }) as VendoAgentTool["input_schema"],
    }));

    const embeds: VendoToolEnvelope[] = [];

    return {
      tools,
      embeds,
      async results(message) {
        const answers: VendoAgentToolResult[] = [];
        // Serially, on one session: the door's approval replay is keyed by the
        // exact call in the exact session, and a write is a write.
        for (const block of message.content) {
          if (!isToolUse(block)) continue;
          const result = await rpc("tools/call", {
            name: block.name,
            arguments: (block.input ?? {}) as Json,
          });
          // The ONLY source of embeds: the door's typed `structuredContent`.
          // Nothing here reads the prose — that is the model's half.
          const envelope = parseVendoToolEnvelope(result["structuredContent"]);
          if (envelope !== null) embeds.push(envelope);
          answers.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: textBlocks(result["content"]),
            is_error: result["isError"] === true,
          });
        }
        return answers;
      },
    };
  };
}
