import type { Json, PermissionGrant, Principal, RunContext, ToolCall, ToolDescriptor, ToolOutcome } from "@vendoai/core";
import type { Connector, ConnectorAccountIdentity } from "./connector.js";
import { normalizeToolName } from "./names.js";

interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

interface McpTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
}

interface McpContent {
  type?: unknown;
  text?: unknown;
}

/** 04-actions §3 — what a per-principal MCP headers resolver sees: the acting
 * principal plus the presence/grant context of the execution. Descriptor
 * listing resolves WITHOUT a principal (a system context). */
export interface McpAuthContext {
  principal?: Principal;
  presence?: RunContext["presence"];
  grant?: PermissionGrant;
}

/** Async per-principal credential resolution for the MCP connector. Shared
 * static headers remain the simple default. */
export type McpHeadersResolver = (
  auth: McpAuthContext,
) => Promise<Record<string, string>> | Record<string, string>;

function mcpError(message: string): ToolOutcome {
  return { status: "error", error: { code: "mcp-error", message } };
}

function rpcErrorMessage(response: JsonRpcResponse): string | undefined {
  if (!response.error) return undefined;
  return typeof response.error.message === "string" ? response.error.message : "MCP JSON-RPC error";
}

function joinedText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as McpContent[])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function parseSseEvent(event: string, id: number): JsonRpcResponse | undefined {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return undefined;
  try {
    const candidate = JSON.parse(data) as JsonRpcResponse;
    return candidate.id === id ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function readSse(response: Response, id: number): Promise<JsonRpcResponse> {
  if (!response.body) throw new Error("MCP SSE response had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let separator = buffer.match(/\r?\n\r?\n/);
    while (separator?.index !== undefined) {
      const event = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const match = parseSseEvent(event, id);
      if (match) {
        await reader.cancel().catch(() => undefined);
        return match;
      }
      separator = buffer.match(/\r?\n\r?\n/);
    }
    if (done) break;
  }
  const trailing = parseSseEvent(buffer, id);
  if (trailing) return trailing;
  throw new Error(`MCP SSE response did not contain JSON-RPC id ${id}`);
}

/** Per-credential MCP protocol state. With static shared headers there is ONE
 * of these; with a per-principal resolver each subject gets its own session so
 * a server binding auth to the session can never mix two users' identities. */
interface McpSession {
  sessionId?: string;
  initialized?: Promise<void>;
}

export function mcpConnector(config: {
  url: string;
  headers?: Record<string, string> | McpHeadersResolver;
  name?: string;
}): Connector {
  const connectorName = config.name ?? "mcp";
  const perPrincipal = typeof config.headers === "function";
  let normalizedToRaw = new Map<string, string>();
  let nextId = 1;
  const sessions = new Map<string, McpSession>();
  /** Bound on cached per-principal protocol sessions: past this, the least
   * recently used session is dropped (its next call re-initializes) so a
   * long-running server with many subjects never grows without limit. */
  const MAX_SESSIONS = 500;

  function sessionFor(auth: McpAuthContext): McpSession {
    const key = perPrincipal ? auth.principal?.subject ?? "" : "";
    let session = sessions.get(key);
    if (session) {
      // Refresh recency (Map iteration order is insertion order).
      sessions.delete(key);
    } else {
      session = {};
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined) sessions.delete(oldest);
      }
    }
    sessions.set(key, session);
    return session;
  }

  async function resolveHeaders(auth: McpAuthContext): Promise<Record<string, string>> {
    if (typeof config.headers === "function") return { ...(await config.headers(auth)) };
    return { ...config.headers };
  }

  async function requestHeaders(auth: McpAuthContext, session: McpSession): Promise<Record<string, string>> {
    return {
      ...(await resolveHeaders(auth)),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
    };
  }

  async function send(
    auth: McpAuthContext,
    session: McpSession,
    body: Record<string, unknown>,
    id?: number,
  ): Promise<JsonRpcResponse | undefined> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(config.url, {
          method: "POST",
          headers: await requestHeaders(auth, session),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const captured = response.headers.get("Mcp-Session-Id");
        if (captured) session.sessionId = captured;
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (contentType.includes("text/event-stream") && response.ok) {
          if (id === undefined) {
            await response.body?.cancel().catch(() => undefined);
            return undefined;
          }
          return await readSse(response, id);
        }
        const text = await response.text();
        if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 200)}`);
        if (id === undefined || !text.trim()) return undefined;
        try {
          return JSON.parse(text) as JsonRpcResponse;
        } catch {
          throw new Error("MCP response was not valid JSON");
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("MCP response timed out");
      throw error;
    }
  }

  function rpc(
    auth: McpAuthContext,
    session: McpSession,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const id = nextId++;
    return send(auth, session, { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, id).then((response) => {
      if (!response) throw new Error(`MCP ${method} returned no response`);
      return response;
    });
  }

  async function ensureInitialized(auth: McpAuthContext, session: McpSession): Promise<void> {
    if (!session.initialized) {
      session.initialized = (async () => {
        const response = await rpc(auth, session, "initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "@vendoai/actions", version: "0.3.0" },
        });
        const message = rpcErrorMessage(response);
        if (message) throw new Error(message);
        await send(auth, session, { jsonrpc: "2.0", method: "notifications/initialized" });
      })();
    }
    await session.initialized;
  }

  return {
    name: connectorName,

    async descriptors(): Promise<ToolDescriptor[]> {
      // Listing is a system operation: no principal (a per-principal resolver
      // sees an empty auth context and may hand back service-level headers).
      const auth: McpAuthContext = {};
      const session = sessionFor(auth);
      await ensureInitialized(auth, session);
      // Built fresh and swapped in atomically so a concurrent execute() never sees a half-empty map.
      const nextNormalizedToRaw = new Map<string, string>();
      const descriptors: ToolDescriptor[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();

      do {
        const response = await rpc(auth, session, "tools/list", cursor ? { cursor } : {});
        const message = rpcErrorMessage(response);
        if (message) throw new Error(message);
        const result = response.result as { tools?: unknown; nextCursor?: unknown } | undefined;
        if (!result || !Array.isArray(result.tools)) throw new Error("MCP tools/list result did not contain tools");
        for (const item of result.tools as McpTool[]) {
          if (typeof item.name !== "string" || !item.name) throw new Error("MCP tool is missing its name");
          const name = normalizeToolName(`mcp_${connectorName}`, item.name);
          if (nextNormalizedToRaw.has(name)) throw new Error(`MCP tool-name collision: ${name}`);
          nextNormalizedToRaw.set(name, item.name);
          const destructive = item.annotations?.destructiveHint === true;
          const readOnly = item.annotations?.readOnlyHint === true;
          descriptors.push({
            name,
            description: typeof item.description === "string" ? item.description : item.name,
            inputSchema:
              item.inputSchema && typeof item.inputSchema === "object" && !Array.isArray(item.inputSchema)
                ? (item.inputSchema as Record<string, unknown>)
                : {},
            risk: destructive ? "destructive" : readOnly ? "read" : "write",
          });
        }
        cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
        if (cursor) {
          if (seenCursors.has(cursor)) throw new Error(`MCP tools/list pagination loop at cursor ${cursor}`);
          seenCursors.add(cursor);
        }
      } while (cursor);

      normalizedToRaw = nextNormalizedToRaw;
      return descriptors;
    },

    async execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
      const raw = normalizedToRaw.get(call.tool);
      if (!raw) return { status: "error", error: { code: "not-found", message: `Unknown MCP tool: ${call.tool}` } };

      // Presence + guard-attached grant context flow through to credential
      // resolution (04-actions §3); the guard attaches `grant` on the ctx for
      // grant-decided runs (ActionsRunContext).
      const auth: McpAuthContext = {
        principal: ctx.principal,
        presence: ctx.presence,
        ...((ctx as { grant?: PermissionGrant }).grant === undefined
          ? {}
          : { grant: (ctx as { grant?: PermissionGrant }).grant }),
      };
      const identity: ConnectorAccountIdentity & { credential: "per-principal" | "shared" } = {
        connector: connectorName,
        entityId: ctx.principal.subject,
        credential: perPrincipal ? "per-principal" : "shared",
      };
      const withIdentity = (outcome: ToolOutcome): ToolOutcome =>
        Object.assign({}, outcome, { connectorAccount: identity });

      try {
        const session = sessionFor(auth);
        await ensureInitialized(auth, session);
        const response = await rpc(auth, session, "tools/call", { name: raw, arguments: call.args });
        const message = rpcErrorMessage(response);
        if (message) return withIdentity(mcpError(message));
        const result = response.result as
          | { isError?: unknown; content?: unknown; structuredContent?: unknown }
          | undefined;
        if (!result) return withIdentity(mcpError("MCP tools/call returned no result"));
        const text = joinedText(result.content);
        if (result.isError === true) return withIdentity(mcpError(text || "MCP tool returned an error"));
        if (result.structuredContent !== undefined) {
          return withIdentity({ status: "ok", output: result.structuredContent as Json });
        }
        if (!text) return withIdentity({ status: "ok", output: "" });
        try {
          return withIdentity({ status: "ok", output: JSON.parse(text) as Json });
        } catch {
          return withIdentity({ status: "ok", output: text });
        }
      } catch (error) {
        return withIdentity(mcpError(error instanceof Error ? error.message : "MCP execution failed"));
      }
    },
  };
}
