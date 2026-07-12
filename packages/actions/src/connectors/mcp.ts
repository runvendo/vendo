import type { Json, RunContext, ToolCall, ToolDescriptor, ToolOutcome } from "@vendoai/core";
import type { Connector } from "./connector.js";
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

function parseSse(text: string, id: number): JsonRpcResponse {
  const candidates: JsonRpcResponse[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      candidates.push(JSON.parse(data) as JsonRpcResponse);
    } catch {
      // Ignore unrelated/non-JSON SSE events and keep looking for this request.
    }
  }
  const match = candidates.find((candidate) => candidate.id === id);
  if (!match) throw new Error(`MCP SSE response did not contain JSON-RPC id ${id}`);
  return match;
}

export function mcpConnector(config: {
  url: string;
  headers?: Record<string, string>;
  name?: string;
}): Connector {
  const connectorName = config.name ?? "mcp";
  const normalizedToRaw = new Map<string, string>();
  let nextId = 1;
  let sessionId: string | undefined;
  let initialized: Promise<void> | undefined;

  function requestHeaders(): Record<string, string> {
    return {
      ...config.headers,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    };
  }

  async function send(body: Record<string, unknown>, id?: number): Promise<JsonRpcResponse | undefined> {
    const response = await fetch(config.url, {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify(body),
    });
    const captured = response.headers.get("Mcp-Session-Id");
    if (captured) sessionId = captured;
    const text = await response.text();
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 200)}`);
    if (id === undefined || !text.trim()) return undefined;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/event-stream")) return parseSse(text, id);
    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new Error("MCP response was not valid JSON");
    }
  }

  function rpc(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = nextId++;
    return send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, id).then((response) => {
      if (!response) throw new Error(`MCP ${method} returned no response`);
      return response;
    });
  }

  async function ensureInitialized(): Promise<void> {
    if (!initialized) {
      initialized = (async () => {
        const response = await rpc("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "@vendoai/actions", version: "0.3.0" },
        });
        const message = rpcErrorMessage(response);
        if (message) throw new Error(message);
        await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      })();
    }
    await initialized;
  }

  return {
    name: connectorName,

    async descriptors(): Promise<ToolDescriptor[]> {
      await ensureInitialized();
      normalizedToRaw.clear();
      const descriptors: ToolDescriptor[] = [];
      let cursor: string | undefined;

      do {
        const response = await rpc("tools/list", cursor ? { cursor } : {});
        const message = rpcErrorMessage(response);
        if (message) throw new Error(message);
        const result = response.result as { tools?: unknown; nextCursor?: unknown } | undefined;
        if (!result || !Array.isArray(result.tools)) throw new Error("MCP tools/list result did not contain tools");
        for (const item of result.tools as McpTool[]) {
          if (typeof item.name !== "string" || !item.name) throw new Error("MCP tool is missing its name");
          const name = normalizeToolName(`mcp_${connectorName}`, item.name);
          if (normalizedToRaw.has(name)) throw new Error(`MCP tool-name collision: ${name}`);
          normalizedToRaw.set(name, item.name);
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
      } while (cursor);

      return descriptors;
    },

    async execute(call: ToolCall, _ctx: RunContext): Promise<ToolOutcome> {
      const raw = normalizedToRaw.get(call.tool);
      if (!raw) return { status: "error", error: { code: "not-found", message: `Unknown MCP tool: ${call.tool}` } };

      try {
        await ensureInitialized();
        const response = await rpc("tools/call", { name: raw, arguments: call.args });
        const message = rpcErrorMessage(response);
        if (message) return mcpError(message);
        const result = response.result as
          | { isError?: unknown; content?: unknown; structuredContent?: unknown }
          | undefined;
        if (!result) return mcpError("MCP tools/call returned no result");
        const text = joinedText(result.content);
        if (result.isError === true) return mcpError(text || "MCP tool returned an error");
        if (result.structuredContent !== undefined) return { status: "ok", output: result.structuredContent as Json };
        if (!text) return { status: "ok", output: "" };
        try {
          return { status: "ok", output: JSON.parse(text) as Json };
        } catch {
          return { status: "ok", output: text };
        }
      } catch (error) {
        return mcpError(error instanceof Error ? error.message : "MCP execution failed");
      }
    },
  };
}
