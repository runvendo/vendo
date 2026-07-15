import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionGrant, RunContext } from "@vendoai/core";
import { mcpConnector, type McpAuthContext } from "./mcp.js";

const ada: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const bob: RunContext = {
  principal: { kind: "user", subject: "user_bob" },
  venue: "chat",
  presence: "present",
  sessionId: "session_bob",
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

/** An MCP stub that records the authorization header + session id per request
 * and issues one session id per initialize. */
function mcpStub() {
  const calls: Array<{ method: string; authorization?: string; session?: string }> = [];
  let sessions = 0;
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await jsonBody(req);
    const method = body.method as string;
    calls.push({
      method,
      ...(typeof req.headers.authorization === "string" ? { authorization: req.headers.authorization } : {}),
      ...(typeof req.headers["mcp-session-id"] === "string" ? { session: req.headers["mcp-session-id"] as string } : {}),
    });
    const id = body.id;
    res.setHeader("content-type", "application/json");
    if (method === "initialize") {
      sessions += 1;
      res.setHeader("Mcp-Session-Id", `session-${sessions}`);
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26" } }));
      return;
    }
    if (method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (method === "tools/list") {
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { tools: [{ name: "lookup", description: "Lookup", inputSchema: {} }] },
      }));
      return;
    }
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
    }));
  };
  return { handler, calls };
}

describe("mcpConnector per-principal headers", () => {
  it("resolves headers per principal and passes presence + grant context through", async () => {
    const stub = mcpStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);

    const resolved: McpAuthContext[] = [];
    const connector = mcpConnector({
      url: server.url,
      name: "warehouse",
      headers: async (auth) => {
        resolved.push(auth);
        return { authorization: `Bearer token-for-${auth.principal?.subject ?? "listing"}` };
      },
    });

    await connector.descriptors();
    // Descriptor listing resolves without a principal (system context).
    expect(resolved[0]?.principal).toBeUndefined();

    const grant: PermissionGrant = {
      id: "grt_1",
      subject: "user_ada",
      tool: "mcp_warehouse_lookup",
      descriptorHash: "sha256:x",
      scope: { kind: "tool" },
      duration: "task",
      contextKey: "session_ada",
      source: "approval",
      grantedAt: "2026-07-15T00:00:00Z",
    };
    const outcome = await connector.execute(
      { id: "call_1", tool: "mcp_warehouse_lookup", args: {} },
      { ...ada, presence: "away", grant } as RunContext,
    );
    expect(outcome).toMatchObject({
      status: "ok",
      connectorAccount: { connector: "warehouse", entityId: "user_ada", credential: "per-principal" },
    });
    const executeAuth = resolved.at(-1);
    expect(executeAuth?.principal?.subject).toBe("user_ada");
    expect(executeAuth?.presence).toBe("away");
    expect(executeAuth?.grant?.id).toBe("grt_1");

    const adaCall = stub.calls.find((call) => call.method === "tools/call");
    expect(adaCall?.authorization).toBe("Bearer token-for-user_ada");
  });

  it("keeps MCP sessions isolated per principal when headers are per-principal", async () => {
    const stub = mcpStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);

    const connector = mcpConnector({
      url: server.url,
      name: "warehouse",
      headers: (auth) => ({ authorization: `Bearer ${auth.principal?.subject ?? "listing"}` }),
    });
    await connector.descriptors();
    await connector.execute({ id: "c1", tool: "mcp_warehouse_lookup", args: {} }, ada);
    await connector.execute({ id: "c2", tool: "mcp_warehouse_lookup", args: {} }, bob);

    // Three initializes: listing, ada, bob — one session each; the two
    // principals' tools/call requests ride DIFFERENT sessions.
    expect(stub.calls.filter((call) => call.method === "initialize")).toHaveLength(3);
    const toolCalls = stub.calls.filter((call) => call.method === "tools/call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.session).toBeDefined();
    expect(toolCalls[0]?.session).not.toBe(toolCalls[1]?.session);
  });

  it("keeps shared static headers as the simple default with a shared credential identity", async () => {
    const stub = mcpStub();
    const server = await startServer(stub.handler);
    closers.push(server.close);

    const connector = mcpConnector({ url: server.url, name: "warehouse", headers: { authorization: "Bearer shared" } });
    await connector.descriptors();
    const outcome = await connector.execute({ id: "c1", tool: "mcp_warehouse_lookup", args: {} }, ada);
    await connector.execute({ id: "c2", tool: "mcp_warehouse_lookup", args: {} }, bob);
    expect(outcome).toMatchObject({
      status: "ok",
      connectorAccount: { connector: "warehouse", entityId: "user_ada", credential: "shared" },
    });
    // One shared session: a single initialize serves both principals.
    expect(stub.calls.filter((call) => call.method === "initialize")).toHaveLength(1);
    for (const call of stub.calls.filter((entry) => entry.method === "tools/call")) {
      expect(call.authorization).toBe("Bearer shared");
    }
  });
});
