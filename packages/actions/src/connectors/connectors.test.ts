import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { toolOutcomeSchema, type RunContext } from "@vendoai/core";
import { composioConnector } from "./composio.js";
import { mcpConnector } from "./mcp.js";
import { normalizeToolName } from "./names.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_1" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
};

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("normalizeToolName", () => {
  it("sanitizes and hashes long names deterministically", () => {
    expect(normalizeToolName("Git Hub", "Create!!!Issue")).toBe("git_hub_Create_Issue");
    const long = normalizeToolName("MCP_Server", "x".repeat(100));
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^mcp_server_x+_[0-9a-f]{6}$/);
    expect(normalizeToolName("MCP_Server", "x".repeat(100))).toBe(long);
  });
});

describe("composioConnector", () => {
  it("paginates descriptors and maps execute success and errors", async () => {
    const seen: Array<{ path: string; query: URLSearchParams; body?: Record<string, unknown> }> = [];
    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://stub");
      expect(req.headers["x-api-key"]).toBe("secret");
      if (req.method === "GET") {
        seen.push({ path: url.pathname, query: url.searchParams });
        res.setHeader("content-type", "application/json");
        if (!url.searchParams.has("cursor")) {
          res.end(JSON.stringify({
            items: [{
              slug: "SEND_EMAIL",
              toolkit_slug: "gmail",
              description: "Send email",
              input_parameters: { type: "object", properties: { to: { type: "string" } } },
            }],
            next_cursor: "page_2",
          }));
        } else {
          res.end(JSON.stringify({
            items: [{ slug: "LIST_THREADS", toolkit: { slug: "gmail" }, description: "List threads", input_parameters: {} }],
          }));
        }
        return;
      }

      const body = await jsonBody(req);
      seen.push({ path: url.pathname, query: url.searchParams, body });
      res.setHeader("content-type", "application/json");
      if (url.pathname.endsWith("SEND_EMAIL")) {
        res.end(JSON.stringify({ successful: true, data: { messageId: "msg_1" } }));
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ successful: false, error: "provider rejected call" }));
      }
    });
    closers.push(server.close);

    const connector = composioConnector({
      apiKey: "secret",
      apps: ["gmail"],
      baseUrl: server.url,
      entityId: () => "entity_1",
    });
    const descriptors = await connector.descriptors();
    expect(descriptors).toEqual([
      expect.objectContaining({ name: "gmail_SEND_EMAIL", risk: "write", description: "Send email" }),
      // The curated risk map (04-actions §3) reads the slug verb: LIST_* is read.
      expect.objectContaining({ name: "gmail_LIST_THREADS", risk: "read" }),
    ]);
    expect(seen[0]?.query.get("toolkit_slug")).toBe("gmail");
    expect(seen[1]?.query.get("cursor")).toBe("page_2");

    const outcome = await connector.execute(
      { id: "call_1", tool: "gmail_SEND_EMAIL", args: { to: "a@example.test" } },
      ctx,
    );
    // Execution outcomes carry the audit identity passthrough (connectorAccount).
    expect(toolOutcomeSchema.parse(outcome)).toMatchObject({ status: "ok", output: { messageId: "msg_1" } });
    expect(outcome).toMatchObject({ connectorAccount: { connector: "composio", toolkit: "gmail", entityId: "entity_1" } });
    expect(seen[2]?.body).toEqual({ user_id: "entity_1", arguments: { to: "a@example.test" } });

    const rejected = await connector.execute(
      { id: "call_2", tool: "gmail_LIST_THREADS", args: {} },
      ctx,
    );
    expect(toolOutcomeSchema.parse(rejected)).toMatchObject({
      status: "error",
      error: { code: "connector-error", message: "provider rejected call" },
    });

    const unknown = await connector.execute({ id: "call_3", tool: "missing", args: {} }, ctx);
    expect(toolOutcomeSchema.parse(unknown)).toMatchObject({ status: "error", error: { code: "not-found" } });
  });

  it("fails closed when a pagination cursor repeats", async () => {
    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ items: [], next_cursor: "repeat" }));
    });
    closers.push(server.close);

    const connector = composioConnector({ apiKey: "secret", baseUrl: server.url });
    await expect(connector.descriptors()).rejects.toThrow("Composio pagination loop");
  });
});

describe("mcpConnector", () => {
  it("initializes a session, paginates tools, parses SSE, and maps call results", async () => {
    const methods: string[] = [];
    const sessionHeaders: Array<string | undefined> = [];
    const server = await startServer(async (req, res) => {
      const body = await jsonBody(req);
      const method = body.method as string;
      methods.push(method);
      sessionHeaders.push(req.headers["mcp-session-id"] as string | undefined);
      const id = body.id;

      if (method === "initialize") {
        expect((body.params as { protocolVersion: string }).protocolVersion).toBe("2025-03-26");
        res.setHeader("Mcp-Session-Id", "session-from-server");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26" } }));
        return;
      }
      expect(req.headers["mcp-session-id"]).toBe("session-from-server");
      if (method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (method === "tools/list") {
        const cursor = (body.params as { cursor?: string }).cursor;
        if (!cursor) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                { name: "lookup", description: "Lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
                { name: "explode", description: "Explode", inputSchema: {}, annotations: { destructiveHint: true } },
              ],
              nextCursor: "next",
            },
          }));
        } else {
          res.setHeader("content-type", "text/event-stream");
          res.end(`event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { tools: [{ name: "x".repeat(90), description: "Long", inputSchema: {} }] },
          })}\n\n`);
        }
        return;
      }
      if (method === "tools/call") {
        const params = body.params as { name: string };
        if (params.name === "lookup") {
          res.setHeader("content-type", "text/event-stream");
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} })}\n\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "{\"found\":true}" }] },
          })}\n\n`);
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { isError: true, content: [{ type: "text", text: "tool exploded" }] },
          }));
        }
      }
    });
    closers.push(server.close);

    const connector = mcpConnector({ url: server.url, name: "warehouse", headers: { authorization: "Bearer test" } });
    const descriptors = await connector.descriptors();
    expect(descriptors[0]).toMatchObject({ name: "mcp_warehouse_lookup", risk: "read" });
    expect(descriptors[1]).toMatchObject({ name: "mcp_warehouse_explode", risk: "destructive" });
    expect(descriptors[2]?.name).toHaveLength(64);
    expect(descriptors[2]?.risk).toBe("write");

    const ok = await Promise.race([
      connector.execute({ id: "call_1", tool: "mcp_warehouse_lookup", args: { id: 1 } }, ctx),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("persistent SSE call hung")), 1_000)),
    ]);
    expect(toolOutcomeSchema.parse(ok)).toMatchObject({ status: "ok", output: { found: true } });
    expect(ok).toMatchObject({ connectorAccount: { connector: "warehouse", credential: "shared" } });
    const failed = await connector.execute({ id: "call_2", tool: "mcp_warehouse_explode", args: {} }, ctx);
    expect(toolOutcomeSchema.parse(failed)).toMatchObject({
      status: "error",
      error: { code: "mcp-error", message: "tool exploded" },
    });
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
      "tools/call",
      "tools/call",
    ]);
    expect(sessionHeaders.slice(1).every((header) => header === "session-from-server")).toBe(true);
  });

  it("fails closed when a tools/list cursor repeats", async () => {
    const server = await startServer(async (req, res) => {
      const body = await jsonBody(req);
      const id = body.id;
      res.setHeader("content-type", "application/json");
      if (body.method === "initialize") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26" } }));
      } else if (body.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
      } else {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [], nextCursor: "repeat" } }));
      }
    });
    closers.push(server.close);

    const connector = mcpConnector({ url: server.url, name: "loop" });
    await expect(connector.descriptors()).rejects.toThrow("MCP tools/list pagination loop");
  });
});
